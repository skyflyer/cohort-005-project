import { and, eq, inArray, isNotNull, lt, lte } from "drizzle-orm";
import { db } from "~/db";
import {
  purchases,
  refunds,
  RefundStatus,
  videoWatchEvents,
} from "~/db/schema";
import { getCourseLessonIds } from "~/lib/refund-rules.server";

// See docs/adr/0001-approved-refund-deletes-progress-keeps-watch-history.md
export const WATCH_HISTORY_RETENTION_MONTHS = 18;

// Takes the database as a last argument (defaulting to the app database) so tests can pass an in-memory one.
type Database = typeof db;

/**
 * The moment 18 months before `now`, in UTC. The day is clamped to the last
 * day of the target month, so 31 Aug minus 18 months is 28 Feb, not 3 Mar.
 */
function retentionCutoff(now: Date): Date {
  const targetMonth = now.getUTCMonth() - WATCH_HISTORY_RETENTION_MONTHS;
  const lastDay = new Date(
    Date.UTC(now.getUTCFullYear(), targetMonth + 1, 0)
  ).getUTCDate();
  const cutoff = new Date(now);
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(targetMonth);
  cutoff.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  return cutoff;
}

/**
 * Deletes the watch history kept as evidence for every refund approved more
 * than 18 months ago: the refunded learner's watch events on the refunded
 * course, up to the moment of approval. Events after that belong to a later
 * purchase and are kept. Returns the number of rows deleted. Safe to run
 * repeatedly: a second run finds nothing left to delete.
 */
export function deleteExpiredWatchHistory(
  now: Date = new Date(),
  database: Database = db
): number {
  const cutoff = retentionCutoff(now).toISOString();

  const expired = database
    .select({
      userId: purchases.userId,
      courseId: purchases.courseId,
      resolvedAt: refunds.resolvedAt,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(
      and(
        eq(refunds.status, RefundStatus.Approved),
        isNotNull(refunds.resolvedAt),
        lt(refunds.resolvedAt, cutoff)
      )
    )
    .all();

  let deleted = 0;
  for (const { userId, courseId, resolvedAt } of expired) {
    if (resolvedAt === null) continue;
    const lessonIds = getCourseLessonIds(courseId, database);
    if (lessonIds.length === 0) continue;

    deleted += database
      .delete(videoWatchEvents)
      .where(
        and(
          eq(videoWatchEvents.userId, userId),
          inArray(videoWatchEvents.lessonId, lessonIds),
          lte(videoWatchEvents.createdAt, resolvedAt)
        )
      )
      .run().changes;
  }
  return deleted;
}
