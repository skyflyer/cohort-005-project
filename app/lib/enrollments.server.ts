import { eq } from "drizzle-orm";
import { db } from "~/db";
import { courses, enrollments } from "~/db/schema";
import type { Database } from "~/lib/database-types";

/** The courses a learner is enrolled in, for their dashboard. */
export function getUserEnrolledCourses(
  userId: number,
  database: Database = db
) {
  return database
    .select({
      enrollmentId: enrollments.id,
      courseId: enrollments.courseId,
      enrolledAt: enrollments.enrolledAt,
      completedAt: enrollments.completedAt,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      courseDescription: courses.description,
      coverImageUrl: courses.coverImageUrl,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(eq(enrollments.userId, userId))
    .all();
}
