import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  refunds,
  RefundStatus,
  lessons,
  modules,
  videoWatchEvents,
  type courses,
  purchases,
} from "~/db/schema";
import { getDiscountForCountry } from "~/lib/ppp";

export const REFUND_WINDOW_DAYS = 14;
export const MAX_WATCHED_HOURS = 2;

// Server-side refund rules, shared by everything that handles refund
// requests. Functions that read the database take it as a last argument
// (defaulting to the app database) so tests can pass an in-memory one.
type Database = typeof db;
// Read-only helpers also accept a transaction handle.
type Reader = Pick<Database, "select">;

/**
 * A purchase made at a purchasing-power price is given back at what was paid,
 * not at the list price of the course.
 */
export function getRefundableAmount(
  purchase: Pick<typeof purchases.$inferSelect, "amountPaid" | "country">,
  course: Pick<typeof courses.$inferSelect, "price">
): number {
  const pppDiscount = getDiscountForCountry(purchase.country);
  return pppDiscount > 0 ? purchase.amountPaid : course.price;
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
  database: Reader = db
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

/** Whether any seat of a team purchase has been claimed. */
export function hasClaimedSeat(
  purchaseId: number,
  database: Reader = db
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

/**
 * Whether any purchase of the course by the learner was refunded. A learner
 * gets one refund per course, even if they bought it again afterwards.
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
        eq(refunds.status, RefundStatus.Approved)
      )
    )
    .get();
  return approved !== undefined;
}
