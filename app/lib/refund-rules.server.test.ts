import { describe, it, expect } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  getRefundableAmount,
  isWithinRefundWindow,
  getWatchedSeconds,
  hasClaimedSeat,
} from "./refund-rules.server";

describe("getRefundableAmount", () => {
  it("gives back what was paid for a purchasing-power purchase", () => {
    // India is a 50% tier; the learner paid 5000 on a 10000 course
    expect(
      getRefundableAmount({ amountPaid: 5000, country: "IN" }, { price: 10000 })
    ).toBe(5000);
  });

  it("gives back the list price for a non-PPP purchase", () => {
    expect(
      getRefundableAmount({ amountPaid: 9000, country: "US" }, { price: 10000 })
    ).toBe(10000);
  });

  it("gives back the list price when the country is unknown", () => {
    expect(
      getRefundableAmount({ amountPaid: 9000, country: null }, { price: 10000 })
    ).toBe(10000);
  });
});

describe("isWithinRefundWindow", () => {
  const purchasedAt = new Date(2026, 0, 1, 23, 0).toISOString();

  it("is open on the day of purchase", () => {
    expect(isWithinRefundWindow(purchasedAt, new Date(2026, 0, 1, 23, 30))).toBe(
      true
    );
  });

  it("is open on the 14th day, even late in the evening", () => {
    expect(isWithinRefundWindow(purchasedAt, new Date(2026, 0, 15, 23, 59))).toBe(
      true
    );
  });

  it("is closed on the 15th day", () => {
    expect(isWithinRefundWindow(purchasedAt, new Date(2026, 0, 16, 0, 0))).toBe(
      false
    );
  });

  it("counts whole days across a month boundary", () => {
    const lateJan = new Date(2026, 0, 25, 10, 0).toISOString();
    expect(isWithinRefundWindow(lateJan, new Date(2026, 1, 8, 20, 0))).toBe(true);
    expect(isWithinRefundWindow(lateJan, new Date(2026, 1, 9, 0, 1))).toBe(false);
  });
});

describe("getWatchedSeconds", () => {
  function setup() {
    const testDb = createTestDb();
    const { user, course } = seedBaseData(testDb);
    const mod = testDb
      .insert(schema.modules)
      .values({ courseId: course.id, title: "M", position: 1 })
      .returning()
      .get();
    const addLesson = (position: number, courseModuleId = mod.id) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: courseModuleId, title: `L${position}`, position })
        .returning()
        .get();
    const watch = (lessonId: number, positionSeconds: number, userId = user.id) =>
      testDb
        .insert(schema.videoWatchEvents)
        .values({ userId, lessonId, eventType: "pause", positionSeconds })
        .run();
    return { testDb, user, course, addLesson, watch };
  }

  it("is zero when nothing was watched", () => {
    const { testDb, user, course, addLesson } = setup();
    addLesson(1);
    expect(getWatchedSeconds(user.id, course.id, testDb)).toBe(0);
  });

  it("is zero for a course with no lessons", () => {
    const { testDb, user, course } = setup();
    expect(getWatchedSeconds(user.id, course.id, testDb)).toBe(0);
  });

  it("sums the furthest position reached in each lesson", () => {
    const { testDb, user, course, addLesson, watch } = setup();
    const a = addLesson(1);
    const b = addLesson(2);
    const c = addLesson(3);
    watch(a.id, 100);
    watch(a.id, 300);
    watch(a.id, 200);
    watch(b.id, 50);
    watch(c.id, 25.5);
    expect(getWatchedSeconds(user.id, course.id, testDb)).toBe(375.5);
  });

  it("ignores other learners and other courses", () => {
    const { testDb, user, course, addLesson, watch } = setup();
    const mine = addLesson(1);
    watch(mine.id, 120);

    const other = testDb
      .insert(schema.users)
      .values({
        name: "Other",
        email: "other@example.com",
        role: schema.UserRole.Student,
      })
      .returning()
      .get();
    watch(mine.id, 999, other.id);

    const otherCourse = testDb
      .insert(schema.courses)
      .values({
        title: "Other Course",
        slug: "other-course",
        description: "x",
        salesCopy: "x",
        instructorId: course.instructorId,
        categoryId: course.categoryId,
        status: schema.CourseStatus.Published,
      })
      .returning()
      .get();
    const otherMod = testDb
      .insert(schema.modules)
      .values({ courseId: otherCourse.id, title: "O", position: 1 })
      .returning()
      .get();
    const otherLesson = addLesson(1, otherMod.id);
    watch(otherLesson.id, 500);

    expect(getWatchedSeconds(user.id, course.id, testDb)).toBe(120);
  });
});

describe("hasClaimedSeat", () => {
  function setup() {
    const testDb = createTestDb();
    const { user, course } = seedBaseData(testDb);
    const team = testDb
      .insert(schema.teams)
      .values({})
      .returning()
      .get();
    const purchase = testDb
      .insert(schema.purchases)
      .values({ userId: user.id, courseId: course.id, amountPaid: 100 })
      .returning()
      .get();
    const addSeat = (code: string, redeemedAt: string | null) =>
      testDb
        .insert(schema.coupons)
        .values({
          teamId: team.id,
          courseId: course.id,
          code,
          purchaseId: purchase.id,
          redeemedByUserId: redeemedAt ? user.id : null,
          redeemedAt,
        })
        .run();
    return { testDb, purchase, addSeat };
  }

  it("is false when the purchase has no seats", () => {
    const { testDb, purchase } = setup();
    expect(hasClaimedSeat(purchase.id, testDb)).toBe(false);
  });

  it("is false when every seat is unclaimed", () => {
    const { testDb, purchase, addSeat } = setup();
    addSeat("A", null);
    addSeat("B", null);
    expect(hasClaimedSeat(purchase.id, testDb)).toBe(false);
  });

  it("is true when any seat has been claimed", () => {
    const { testDb, purchase, addSeat } = setup();
    addSeat("A", null);
    addSeat("B", new Date().toISOString());
    expect(hasClaimedSeat(purchase.id, testDb)).toBe(true);
  });
});
