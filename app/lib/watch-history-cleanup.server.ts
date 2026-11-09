import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "~/db";
import {
  lessons,
  modules,
  purchases,
  refunds,
  RefundStatus,
  videoWatchEvents,
} from "~/db/schema";

// See docs/adr/0001-approved-refund-deletes-progress-keeps-watch-history.md
export const WATCH_HISTORY_RETENTION_MONTHS = 18;

type Database = typeof db;

/**
 * Deletes the watch history of every learner and course whose refund was
 * approved more than 18 months ago. Returns the number of rows deleted.
 * Safe to run repeatedly: a second run finds nothing left to delete.
 */
export function deleteExpiredWatchHistory(
  now: Date = new Date(),
  database: Database = db
): number {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - WATCH_HISTORY_RETENTION_MONTHS);

  const expired = database
    .selectDistinct({ userId: purchases.userId, courseId: purchases.courseId })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(
      and(
        eq(refunds.status, RefundStatus.Approved),
        isNotNull(refunds.resolvedAt),
        lt(refunds.resolvedAt, cutoff.toISOString())
      )
    )
    .all();

  let deleted = 0;
  for (const { userId, courseId } of expired) {
    const lessonIds = database
      .select({ id: lessons.id })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(eq(modules.courseId, courseId))
      .all()
      .map((row) => row.id);
    if (lessonIds.length === 0) continue;

    deleted += database
      .delete(videoWatchEvents)
      .where(
        and(
          eq(videoWatchEvents.userId, userId),
          inArray(videoWatchEvents.lessonId, lessonIds)
        )
      )
      .run().changes;
  }
  return deleted;
}
