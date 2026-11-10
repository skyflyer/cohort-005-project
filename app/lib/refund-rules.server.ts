import { and, desc, eq, inArray, isNotNull, lte, notExists, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  refunds,
  RefundStatus,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  videoWatchEvents,
  courses,
  purchases,
} from "~/db/schema";
import { MAX_WATCHED_HOURS } from "~/lib/refund-limits";
import { getDiscountForCountry } from "~/lib/ppp";
import type { Database, DatabaseReader } from "~/lib/database-types";

export const REFUND_WINDOW_DAYS = 14;
// A learner who has completed this share of a course's lessons can no longer
// get a refund.
export const REFUND_COMPLETION_LIMIT = 0.5;

// Server-side refund rules, shared by everything that handles refund
// requests. Functions that read the database take it as a last argument
// (defaulting to the app database) so tests can pass an in-memory one.

/**
 * What a refund gives back. A team purchase is given back at what was paid,
 * which covers every seat. A solo purchase made at a purchasing-power price
 * is also given back at what was paid; otherwise at the course's list price.
 */
export function getRefundableAmount(
  purchase: Pick<typeof purchases.$inferSelect, "amountPaid" | "country"> & {
    isTeamPurchase: boolean;
  },
  course: Pick<typeof courses.$inferSelect, "price">
): number {
  if (purchase.isTeamPurchase) return purchase.amountPaid;
  const pppDiscount = getDiscountForCountry(purchase.country);
  return pppDiscount > 0 ? purchase.amountPaid : course.price;
}

/**
 * A team purchase is one that minted seat codes. A team purchase never gives
 * the buyer an enrollment of their own. Voided codes still count: the rows
 * record that the purchase minted seats.
 */
export function isTeamPurchase(
  purchaseId: number,
  database: DatabaseReader = db
): boolean {
  const seat = database
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get();
  return seat !== undefined;
}

// The window is counted in whole days, not hours — someone who buys at 23:00
// should still get the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

export function isWithinRefundWindow(
  purchasedAtIso: string,
  now: Date = new Date()
): boolean {
  return calendarDay(now) <= lastDayOfWindow(purchasedAtIso);
}

/** The ids of every lesson in a course. */
export function getCourseLessonIds(
  courseId: number,
  database: DatabaseReader = db
): number[] {
  return database
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

/**
 * Sum of the furthest position the learner reached in each lesson of the
 * course. With `asOf` (an ISO timestamp), only watch events created at or
 * before it count — the watch time as it stood at that moment.
 */
export function getWatchedSeconds(
  userId: number,
  courseId: number,
  asOf?: string,
  database: Database = db
): number {
  const lessonIds = getCourseLessonIds(courseId, database);

  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = database
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds),
        asOf === undefined ? undefined : lte(videoWatchEvents.createdAt, asOf)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

/**
 * Whether the learner has completed at least REFUND_COMPLETION_LIMIT of the
 * course's lessons, which closes the refund request.
 */
export function hasCompletedTooMuch(
  userId: number,
  courseId: number,
  database: DatabaseReader = db
): boolean {
  const lessonIds = getCourseLessonIds(courseId, database);
  if (lessonIds.length === 0) return false;

  const completed = database
    .select({ id: lessonProgress.id })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .all();

  return completed.length / lessonIds.length >= REFUND_COMPLETION_LIMIT;
}

/**
 * What a refund of this purchase would give back, and whether it is a team
 * purchase (which decides what else approval touches and what we tell the
 * learner). The one place that combines the two.
 */
export function getRefundTerms(
  purchase: Pick<typeof purchases.$inferSelect, "id" | "amountPaid" | "country">,
  course: Pick<typeof courses.$inferSelect, "price">,
  database: DatabaseReader = db
): { amount: number; isTeamPurchase: boolean } {
  const team = isTeamPurchase(purchase.id, database);
  return {
    amount: getRefundableAmount({ ...purchase, isTeamPurchase: team }, course),
    isTeamPurchase: team,
  };
}

/** Whether any seat of a team purchase has been claimed. */
export function hasClaimedSeat(
  purchaseId: number,
  database: DatabaseReader = db
): boolean {
  const seat = database
    .select({ id: coupons.id })
    .from(coupons)
    .where(and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt)))
    .get();
  return seat !== undefined;
}

/** A learner who has watched this much of a course can no longer get a refund. */
export function hasWatchedTooMuch(watchedSeconds: number): boolean {
  return watchedSeconds >= MAX_WATCHED_HOURS * 60 * 60;
}

/** Whether the purchase has a refund request still waiting for a decision. */
export function hasOpenRefundRequest(
  purchaseId: number,
  database: Database = db
): boolean {
  const open = database
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Requested)
      )
    )
    .get();
  return open !== undefined;
}

/** Whether the purchase itself already has an approved refund. */
export function hasApprovedRefundForPurchase(
  purchaseId: number,
  database: Database = db
): boolean {
  const approved = database
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Approved)
      )
    )
    .get();
  return approved !== undefined;
}

/**
 * Whether the learner's own (solo) access to the course was refunded. A
 * learner gets one refund per course for their own access, even if they
 * bought it again afterwards. A refunded team purchase does not count: it
 * never gave the buyer access, so it neither blocks nor is blocked by this.
 */
export function hasApprovedRefundForCourse(
  userId: number,
  courseId: number,
  database: Database = db
): boolean {
  const approved = database
    .select({ id: refunds.id })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(
      and(
        eq(purchases.userId, userId),
        eq(purchases.courseId, courseId),
        eq(refunds.status, RefundStatus.Approved),
        notExists(
          database
            .select({ id: coupons.id })
            .from(coupons)
            .where(eq(coupons.purchaseId, purchases.id))
        )
      )
    )
    .get();
  return approved !== undefined;
}

/**
 * Whether a refund request on this purchase could still be accepted, judged
 * by the rules about the purchase itself: the window, no open or approved
 * request on it, no claimed seat, and for a solo purchase the one refund per
 * course. The learner's own progress limits apply to a solo purchase only.
 * Returns the first reason it cannot, or null.
 */
export function getRefundBlock(
  learner: { id: number },
  course: { id: number },
  purchase: Pick<typeof purchases.$inferSelect, "id" | "createdAt">,
  database: Database = db
): { message: string; status: number } | null {
  const team = isTeamPurchase(purchase.id, database);

  if (!team && hasApprovedRefundForCourse(learner.id, course.id, database)) {
    return {
      message:
        "You have already had a refund for this course, so we cannot accept another refund request for it.",
      status: 409,
    };
  }
  if (hasApprovedRefundForPurchase(purchase.id, database)) {
    return {
      message: "This purchase has already been refunded.",
      status: 409,
    };
  }
  if (hasOpenRefundRequest(purchase.id, database)) {
    return {
      message: "You already have a request open on this purchase.",
      status: 409,
    };
  }
  if (hasClaimedSeat(purchase.id, database)) {
    return { message: "A claimed team seat cannot be refunded.", status: 403 };
  }
  if (!isWithinRefundWindow(purchase.createdAt)) {
    return {
      message: `The ${REFUND_WINDOW_DAYS}-day window has closed.`,
      status: 403,
    };
  }
  if (team) return null;
  if (
    hasWatchedTooMuch(getWatchedSeconds(learner.id, course.id, undefined, database))
  ) {
    return {
      message: "You have watched too much of this course to request a refund.",
      status: 403,
    };
  }
  if (hasCompletedTooMuch(learner.id, course.id, database)) {
    return {
      message: `You have completed ${REFUND_COMPLETION_LIMIT * 100}% or more of this course, so we cannot accept a refund request for it.`,
      status: 403,
    };
  }
  return null;
}

/**
 * What the learner is offered for this purchase if they want their money
 * back, or null if a refund request would be refused. The page and the
 * request share getRefundBlock, so they cannot disagree.
 */
export function getRefundOffer(
  learner: { id: number },
  course: Pick<typeof courses.$inferSelect, "id" | "price">,
  purchase: Pick<
    typeof purchases.$inferSelect,
    "id" | "createdAt" | "amountPaid" | "country"
  >,
  database: Database = db
): { purchaseId: number; amount: number; isTeamPurchase: boolean } | null {
  if (getRefundBlock(learner, course, purchase, database)) return null;
  const terms = getRefundTerms(purchase, course, database);
  return {
    purchaseId: purchase.id,
    amount: terms.amount,
    isTeamPurchase: terms.isTeamPurchase,
  };
}

/**
 * The learner's latest purchase of the course that is not a team purchase: the
 * one that enrolled them. Undefined if they only bought team seats.
 */
export function getLatestSoloPurchase(
  userId: number,
  courseId: number,
  database: Database = db
) {
  return database
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(desc(purchases.createdAt), desc(purchases.id))
    .all()
    .find((purchase) => !isTeamPurchase(purchase.id, database));
}

/**
 * The learner's team purchases (ones that minted seat codes), newest first,
 * each with the course and the refund state the team page needs: what a
 * refund offers, or the status of the latest request on it.
 */
export function getTeamPurchaseRefunds(
  userId: number,
  database: Database = db
) {
  const rows = database
    .select({
      purchase: purchases,
      course: courses,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.userId, userId))
    .orderBy(desc(purchases.createdAt), desc(purchases.id))
    .all()
    .filter((row) => isTeamPurchase(row.purchase.id, database));

  return rows.map(({ purchase, course }) => {
    const latest = database
      .select({ status: refunds.status })
      .from(refunds)
      .where(eq(refunds.purchaseId, purchase.id))
      .orderBy(desc(refunds.requestedAt), desc(refunds.id))
      .get();
    return {
      purchaseId: purchase.id,
      courseSlug: course.slug,
      courseTitle: course.title,
      purchasedAt: purchase.createdAt,
      amountPaid: purchase.amountPaid,
      refundStatus: latest?.status ?? null,
      offer: getRefundOffer({ id: userId }, course, purchase, database),
    };
  });
}
