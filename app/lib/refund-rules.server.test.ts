import { describe, it, expect } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { getDiscountForCountry } from "~/lib/ppp";
import {
  getRefundableAmount,
  getRefundTerms,
  isWithinRefundWindow,
  getWatchedSeconds,
  hasClaimedSeat,
  hasCompletedTooMuch,
  isTeamPurchase,
  hasApprovedRefundForCourse,
  hasOpenRefundRequest,
  hasWatchedTooMuch,
} from "./refund-rules.server";

describe("getRefundableAmount", () => {
  it("gives back what was paid for a purchasing-power purchase", () => {
    // India is a discounted PPP country; the learner paid 5000 on a 10000 course
    expect(getDiscountForCountry("IN")).toBeGreaterThan(0);
    expect(
      getRefundableAmount({ amountPaid: 5000, country: "IN", isTeamPurchase: false }, { price: 10000 })
    ).toBe(5000);
  });

  it("gives back the list price for a non-PPP purchase", () => {
    expect(
      getRefundableAmount({ amountPaid: 9000, country: "US", isTeamPurchase: false }, { price: 10000 })
    ).toBe(10000);
  });

  it("gives back the list price, not a coupon-reduced amount paid, for a non-PPP purchase", () => {
    expect(getDiscountForCountry("US")).toBe(0);
    expect(
      getRefundableAmount({ amountPaid: 7000, country: "US", isTeamPurchase: false }, { price: 10000 })
    ).toBe(10000);
  });

  it("gives back the list price when the country is unknown", () => {
    expect(
      getRefundableAmount({ amountPaid: 9000, country: null, isTeamPurchase: false }, { price: 10000 })
    ).toBe(10000);
  });
});

describe("getRefundableAmount for a team purchase", () => {
  it("gives back everything paid, covering every seat", () => {
    // 5 seats at 9000 each: more than the list price of one seat
    expect(
      getRefundableAmount(
        { amountPaid: 45000, country: "US", isTeamPurchase: true },
        { price: 10000 }
      )
    ).toBe(45000);
  });

  it("gives back what was paid, not the list price, even under purchasing-power pricing", () => {
    expect(
      getRefundableAmount(
        { amountPaid: 15000, country: "IN", isTeamPurchase: true },
        { price: 10000 }
      )
    ).toBe(15000);
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
    const courseModule = testDb
      .insert(schema.modules)
      .values({ courseId: course.id, title: "M", position: 1 })
      .returning()
      .get();
    const addLesson = (position: number, courseModuleId = courseModule.id) =>
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
    expect(getWatchedSeconds(user.id, course.id, undefined, testDb)).toBe(0);
  });

  it("is zero for a course with no lessons", () => {
    const { testDb, user, course } = setup();
    expect(getWatchedSeconds(user.id, course.id, undefined, testDb)).toBe(0);
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
    expect(getWatchedSeconds(user.id, course.id, undefined, testDb)).toBe(375.5);
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

    expect(getWatchedSeconds(user.id, course.id, undefined, testDb)).toBe(120);
  });

  it("counts only events created at or before the cutoff", () => {
    const { testDb, user, course, addLesson } = setup();
    const lesson = addLesson(1);
    const watchAt = (positionSeconds: number, createdAt: string) =>
      testDb
        .insert(schema.videoWatchEvents)
        .values({
          userId: user.id,
          lessonId: lesson.id,
          eventType: "pause",
          positionSeconds,
          createdAt,
        })
        .run();
    watchAt(100, "2026-11-01T10:00:00.000Z");
    watchAt(300, "2026-11-02T10:00:00.000Z");
    watchAt(900, "2026-11-03T10:00:00.000Z");

    expect(
      getWatchedSeconds(
        user.id,
        course.id,
        "2026-11-02T10:00:00.000Z",
        testDb
      )
    ).toBe(300);
    expect(getWatchedSeconds(user.id, course.id, undefined, testDb)).toBe(900);
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

describe("hasWatchedTooMuch", () => {
  it("is false just under 2 hours", () => {
    expect(hasWatchedTooMuch(2 * 60 * 60 - 1)).toBe(false);
  });

  it("is true at exactly 2 hours", () => {
    expect(hasWatchedTooMuch(2 * 60 * 60)).toBe(true);
  });
});

describe("hasOpenRefundRequest", () => {
  function setup() {
    const testDb = createTestDb();
    const { user, course } = seedBaseData(testDb);
    const purchase = testDb
      .insert(schema.purchases)
      .values({ userId: user.id, courseId: course.id, amountPaid: 1000 })
      .returning()
      .get();
    const request = (status: schema.RefundStatus) =>
      testDb
        .insert(schema.refunds)
        .values({ purchaseId: purchase.id, status, reason: "Not for me." })
        .run();
    return { testDb, purchase, request };
  }

  it("is false when no request was made", () => {
    const { testDb, purchase } = setup();
    expect(hasOpenRefundRequest(purchase.id, testDb)).toBe(false);
  });

  it("is true while a request waits for a decision", () => {
    const { testDb, purchase, request } = setup();
    request(schema.RefundStatus.Requested);
    expect(hasOpenRefundRequest(purchase.id, testDb)).toBe(true);
  });

  it("is false after the request was declined, so the learner can ask again", () => {
    const { testDb, purchase, request } = setup();
    request(schema.RefundStatus.Declined);
    expect(hasOpenRefundRequest(purchase.id, testDb)).toBe(false);
  });
});

describe("hasApprovedRefundForCourse", () => {
  function setup() {
    const testDb = createTestDb();
    const { user, course } = seedBaseData(testDb);
    const buy = () =>
      testDb
        .insert(schema.purchases)
        .values({ userId: user.id, courseId: course.id, amountPaid: 1000 })
        .returning()
        .get();
    const refund = (purchaseId: number, status: schema.RefundStatus) =>
      testDb
        .insert(schema.refunds)
        .values({ purchaseId, status, reason: "Not for me." })
        .run();
    return { testDb, user, course, buy, refund };
  }

  it("is false when the learner never had a refund", () => {
    const { testDb, user, course, buy } = setup();
    buy();
    expect(hasApprovedRefundForCourse(user.id, course.id, testDb)).toBe(false);
  });

  it("is true when a purchase of the course was refunded", () => {
    const { testDb, user, course, buy, refund } = setup();
    refund(buy().id, schema.RefundStatus.Approved);
    expect(hasApprovedRefundForCourse(user.id, course.id, testDb)).toBe(true);
  });

  it("is still true after the learner bought the course again", () => {
    const { testDb, user, course, buy, refund } = setup();
    refund(buy().id, schema.RefundStatus.Approved);
    buy();
    expect(hasApprovedRefundForCourse(user.id, course.id, testDb)).toBe(true);
  });

  it("is false when the earlier request was declined", () => {
    const { testDb, user, course, buy, refund } = setup();
    refund(buy().id, schema.RefundStatus.Declined);
    expect(hasApprovedRefundForCourse(user.id, course.id, testDb)).toBe(false);
  });

  it("is false when the request is still open", () => {
    const { testDb, user, course, buy, refund } = setup();
    refund(buy().id, schema.RefundStatus.Requested);
    expect(hasApprovedRefundForCourse(user.id, course.id, testDb)).toBe(false);
  });

  it("is false for a refund of a different course", () => {
    const { testDb, user, course, buy, refund } = setup();
    refund(buy().id, schema.RefundStatus.Approved);
    expect(hasApprovedRefundForCourse(user.id, course.id + 1, testDb)).toBe(
      false
    );
  });
});

describe("isTeamPurchase", () => {
  function setup() {
    const testDb = createTestDb();
    const { user, course } = seedBaseData(testDb);
    const purchase = testDb
      .insert(schema.purchases)
      .values({ userId: user.id, courseId: course.id, amountPaid: 100 })
      .returning()
      .get();
    return { testDb, user, course, purchase };
  }

  it("is false for a purchase that minted no seat codes", () => {
    const { testDb, purchase } = setup();
    expect(isTeamPurchase(purchase.id, testDb)).toBe(false);
  });

  it("is true once the purchase has minted seat codes, even voided ones", () => {
    const { testDb, course, purchase } = setup();
    const team = testDb.insert(schema.teams).values({}).returning().get();
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code: "SEAT-1",
        purchaseId: purchase.id,
        voidedAt: "2026-11-05T10:00:00.000Z",
      })
      .run();
    expect(isTeamPurchase(purchase.id, testDb)).toBe(true);
  });
});

describe("hasCompletedTooMuch", () => {
  function setup(lessonCount: number) {
    const testDb = createTestDb();
    const { user, course } = seedBaseData(testDb);
    const mod = testDb
      .insert(schema.modules)
      .values({ courseId: course.id, title: "M", position: 1 })
      .returning()
      .get();
    const lessonIds = Array.from({ length: lessonCount }, (_, i) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `L${i}`, position: i + 1 })
        .returning()
        .get().id
    );
    const complete = (count: number) =>
      lessonIds.slice(0, count).forEach((lessonId) =>
        testDb
          .insert(schema.lessonProgress)
          .values({
            userId: user.id,
            lessonId,
            status: schema.LessonProgressStatus.Completed,
          })
          .run()
      );
    return { testDb, user, course, complete };
  }

  it("is false below half of the lessons", () => {
    const { testDb, user, course, complete } = setup(4);
    complete(1);
    expect(hasCompletedTooMuch(user.id, course.id, testDb)).toBe(false);
  });

  it("is true at exactly half of the lessons", () => {
    const { testDb, user, course, complete } = setup(4);
    complete(2);
    expect(hasCompletedTooMuch(user.id, course.id, testDb)).toBe(true);
  });

  it("is false for a course with no lessons", () => {
    const { testDb, user, course } = setup(0);
    expect(hasCompletedTooMuch(user.id, course.id, testDb)).toBe(false);
  });
});

describe("getRefundTerms", () => {
  it("returns the amount and whether the purchase is a team purchase", () => {
    const testDb = createTestDb();
    const { user, course } = seedBaseData(testDb);
    const purchase = testDb
      .insert(schema.purchases)
      .values({ userId: user.id, courseId: course.id, amountPaid: 45000, country: "US" })
      .returning()
      .get();

    expect(getRefundTerms(purchase, { price: 10000 }, testDb)).toEqual({
      amount: 10000,
      isTeamPurchase: false,
    });

    const team = testDb.insert(schema.teams).values({}).returning().get();
    testDb
      .insert(schema.coupons)
      .values({ teamId: team.id, courseId: course.id, code: "S1", purchaseId: purchase.id })
      .run();

    expect(getRefundTerms(purchase, { price: 10000 }, testDb)).toEqual({
      amount: 45000,
      isTeamPurchase: true,
    });
  });
});
