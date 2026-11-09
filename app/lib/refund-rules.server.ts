import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessons,
  modules,
  videoWatchEvents,
  type courses,
  type purchases,
} from "~/db/schema";
import { getDiscountForCountry } from "~/lib/ppp";

export const REFUND_WINDOW_DAYS = 14;

// Server-side refund rules, shared by everything that handles refund
// requests. Functions that read the database take it as a last argument
// (defaulting to the app database) so tests can pass an in-memory one.
type Database = typeof db;

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

/** Sum of the furthest position the learner reached in each lesson of the course. */
export function getWatchedSeconds(
  userId: number,
  courseId: number,
  database: Database = db
): number {
  const lessonIds = database
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);

  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = database
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

/** Whether any seat of a team purchase has been claimed. */
export function hasClaimedSeat(
  purchaseId: number,
  database: Database = db
): boolean {
  const seat = database
    .select({ id: coupons.id })
    .from(coupons)
    .where(and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt)))
    .get();
  return seat !== undefined;
}
