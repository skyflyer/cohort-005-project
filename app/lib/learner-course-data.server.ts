import { and, count, eq, inArray } from "drizzle-orm";
import {
  courseRatings,
  enrollments,
  lessonProgress,
  quizAnswers,
  quizAttempts,
  quizzes,
} from "~/db/schema";
import type { DatabaseReader, DatabaseTransaction } from "~/lib/database-types";
import { getCourseLessonIds } from "~/lib/refund-rules.server";

/** How many lessons of the course the learner has a progress row for. */
export function countLessonsWithProgress(
  userId: number,
  courseId: number,
  database: DatabaseReader
): number {
  const lessonIds = getCourseLessonIds(courseId, database);
  if (lessonIds.length === 0) return 0;

  const row = database
    .select({ lessons: count() })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();
  return row?.lessons ?? 0;
}

/**
 * The single place that implements the deletion list of ADR 0001
 * (docs/adr/0001-approved-refund-deletes-progress-keeps-watch-history.md):
 * the learner's enrollment, lesson progress, quiz attempts and answers, and
 * rating for one course. Watch history and comments are deliberately not
 * touched. Every delete is scoped to the one course. Call it inside a
 * transaction.
 */
export function deleteLearnerCourseData(
  tx: DatabaseTransaction,
  learnerId: number,
  courseId: number
) {
  const lessonIds = getCourseLessonIds(courseId, tx);

  if (lessonIds.length > 0) {
    const attemptIds = tx
      .select({ id: quizAttempts.id })
      .from(quizAttempts)
      .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
      .where(
        and(
          eq(quizAttempts.userId, learnerId),
          inArray(quizzes.lessonId, lessonIds)
        )
      )
      .all()
      .map((row) => row.id);

    // Answers go before the attempts they point at.
    if (attemptIds.length > 0) {
      tx.delete(quizAnswers)
        .where(inArray(quizAnswers.attemptId, attemptIds))
        .run();
      tx.delete(quizAttempts).where(inArray(quizAttempts.id, attemptIds)).run();
    }

    tx.delete(lessonProgress)
      .where(
        and(
          eq(lessonProgress.userId, learnerId),
          inArray(lessonProgress.lessonId, lessonIds)
        )
      )
      .run();
  }

  tx.delete(courseRatings)
    .where(
      and(
        eq(courseRatings.userId, learnerId),
        eq(courseRatings.courseId, courseId)
      )
    )
    .run();

  tx.delete(enrollments)
    .where(
      and(eq(enrollments.userId, learnerId), eq(enrollments.courseId, courseId))
    )
    .run();
}
