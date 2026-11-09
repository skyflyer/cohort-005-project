import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { deleteExpiredWatchHistory } from "./watch-history-cleanup.server";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const OLD = "2025-03-01T10:00:00.000Z"; // about 20 months before NOW
const RECENT = "2026-03-01T10:00:00.000Z"; // about 8 months before NOW

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const testDb = createTestDb();
  const { user, course, category, instructor } = seedBaseData(testDb);

  const otherCourse = testDb
    .insert(schema.courses)
    .values({
      title: "Other Course",
      slug: "other-course",
      description: "Another course",
      salesCopy: "Other",
      instructorId: instructor.id,
      categoryId: category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();

  const addLesson = (courseId: number, title: string) => {
    const mod = testDb
      .insert(schema.modules)
      .values({ courseId, title: `${title} module`, position: 1 })
      .returning()
      .get();
    return testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title, position: 1 })
      .returning()
      .get();
  };

  const lesson = addLesson(course.id, "Lesson");
  const otherLesson = addLesson(otherCourse.id, "Other lesson");

  const watch = (userId: number, lessonId: number) =>
    testDb
      .insert(schema.videoWatchEvents)
      .values({ userId, lessonId, eventType: "play", positionSeconds: 30 })
      .run();

  const refundCourse = (
    userId: number,
    courseId: number,
    status: schema.RefundStatus,
    resolvedAt: string | null
  ) => {
    const purchase = testDb
      .insert(schema.purchases)
      .values({ userId, courseId, amountPaid: 100 })
      .returning()
      .get();
    testDb
      .insert(schema.refunds)
      .values({ purchaseId: purchase.id, status, reason: "No", resolvedAt })
      .run();
  };

  const remaining = () =>
    testDb
      .select()
      .from(schema.videoWatchEvents)
      .all()
      .map((e) => `${e.userId}:${e.lessonId}`)
      .sort();

  return { testDb, user, course, lesson, otherLesson, watch, refundCourse, remaining };
}

describe("deleteExpiredWatchHistory", () => {
  it("deletes the refunded learner's watch history on the refunded course after 18 months", () => {
    const { testDb, user, course, lesson, watch, refundCourse, remaining } = setup();
    watch(user.id, lesson.id);
    refundCourse(user.id, course.id, schema.RefundStatus.Approved, OLD);

    expect(deleteExpiredWatchHistory(NOW, testDb)).toBe(1);
    expect(remaining()).toEqual([]);
  });

  it("keeps watch history on the learner's other courses and other learners' history", () => {
    const { testDb, user, course, lesson, otherLesson, watch, refundCourse, remaining } =
      setup();
    const other = testDb
      .insert(schema.users)
      .values({ name: "Other", email: "o@example.com", role: schema.UserRole.Student })
      .returning()
      .get();
    watch(user.id, lesson.id);
    watch(user.id, otherLesson.id);
    watch(other.id, lesson.id);
    refundCourse(user.id, course.id, schema.RefundStatus.Approved, OLD);

    expect(deleteExpiredWatchHistory(NOW, testDb)).toBe(1);
    expect(remaining()).toEqual([
      `${user.id}:${otherLesson.id}`,
      `${other.id}:${lesson.id}`,
    ]);
  });

  it("keeps watch history when the refund was approved less than 18 months ago", () => {
    const { testDb, user, course, lesson, watch, refundCourse, remaining } = setup();
    watch(user.id, lesson.id);
    refundCourse(user.id, course.id, schema.RefundStatus.Approved, RECENT);

    expect(deleteExpiredWatchHistory(NOW, testDb)).toBe(0);
    expect(remaining()).toEqual([`${user.id}:${lesson.id}`]);
  });

  it("keeps watch history for requested and declined refunds", () => {
    const { testDb, user, course, lesson, watch, refundCourse, remaining } = setup();
    watch(user.id, lesson.id);
    refundCourse(user.id, course.id, schema.RefundStatus.Requested, null);
    refundCourse(user.id, course.id, schema.RefundStatus.Declined, OLD);

    expect(deleteExpiredWatchHistory(NOW, testDb)).toBe(0);
    expect(remaining()).toEqual([`${user.id}:${lesson.id}`]);
  });

  it("keeps watch history for an approved refund with no approval time", () => {
    const { testDb, user, course, lesson, watch, refundCourse, remaining } = setup();
    watch(user.id, lesson.id);
    refundCourse(user.id, course.id, schema.RefundStatus.Approved, null);

    expect(deleteExpiredWatchHistory(NOW, testDb)).toBe(0);
    expect(remaining()).toEqual([`${user.id}:${lesson.id}`]);
  });

  it("is safe to run repeatedly", () => {
    const { testDb, user, course, lesson, watch, refundCourse } = setup();
    watch(user.id, lesson.id);
    refundCourse(user.id, course.id, schema.RefundStatus.Approved, OLD);

    expect(deleteExpiredWatchHistory(NOW, testDb)).toBe(1);
    expect(deleteExpiredWatchHistory(NOW, testDb)).toBe(0);
  });
});
