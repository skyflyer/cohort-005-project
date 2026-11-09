import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  getCourseRevenue,
  getCourseRevenueByCountry,
  getRevenueOverTime,
  getRevenueSummary,
  getStudentRevenue,
  getTopBuyers,
} from "./revenue.server";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const testDb = createTestDb();
  const { user, instructor, course } = seedBaseData(testDb);

  const buy = (amountPaid: number, createdAt: string, userId = user.id) =>
    testDb
      .insert(schema.purchases)
      .values({ userId, courseId: course.id, amountPaid, createdAt })
      .returning()
      .get();

  // Seeds a refund row directly — no dependency on the approval flow.
  const refund = (
    purchaseId: number,
    status: schema.RefundStatus,
    amountRefunded: number | null,
    resolvedAt: string | null
  ) =>
    testDb
      .insert(schema.refunds)
      .values({ purchaseId, status, reason: "Not for me", amountRefunded, resolvedAt })
      .run();

  return { testDb, user, instructor, course, buy, refund };
}

describe("getRevenueSummary", () => {
  it("shows gross, refunds and net for the range", () => {
    const { testDb, instructor, buy, refund } = setup();
    const purchase = buy(10000, daysAgo(5));
    buy(5000, daysAgo(4));
    refund(purchase.id, schema.RefundStatus.Approved, 10000, daysAgo(3));

    expect(getRevenueSummary(instructor.id, "30d", testDb)).toEqual({
      grossCents: 15000,
      refundsCents: 10000,
      // 20% fee on what remains after the refund: 5000 - 1000
      feeCents: 1000,
      netCents: 4000,
      purchaseCount: 2,
    });
  });

  it("ignores an approved refund that has no approval time", () => {
    const { testDb, instructor, buy, refund } = setup();
    const purchase = buy(10000, daysAgo(5));
    refund(purchase.id, schema.RefundStatus.Approved, 10000, null);

    expect(getRevenueSummary(instructor.id, "all", testDb)).toMatchObject({
      grossCents: 10000,
      refundsCents: 0,
    });
    expect(() => getRevenueOverTime(instructor.id, "all", testDb)).not.toThrow();
  });

  it("shows negative net for a period with a refund and no sales", () => {
    const { testDb, instructor, buy, refund } = setup();
    const purchase = buy(10000, daysAgo(40));
    refund(purchase.id, schema.RefundStatus.Approved, 10000, daysAgo(1));

    expect(getRevenueSummary(instructor.id, "30d", testDb)).toEqual({
      grossCents: 0,
      refundsCents: 10000,
      feeCents: -2000,
      netCents: -8000,
      purchaseCount: 0,
    });
  });

  it("counts a refund in the period it was approved, not the period of the purchase", () => {
    const { testDb, instructor, buy, refund } = setup();
    const purchase = buy(10000, daysAgo(20));
    refund(purchase.id, schema.RefundStatus.Approved, 10000, daysAgo(2));

    // The purchase's period is untouched by a later refund
    // (the 30d range holds both, so look at a window ending before the refund
    // via the series below); here the refund lands in the 7d range only.
    expect(getRevenueSummary(instructor.id, "7d", testDb)).toMatchObject({
      grossCents: 0,
      refundsCents: 10000,
      netCents: -8000,
    });
  });

  it("subtracts only the amount refunded, which can be less than the amount paid", () => {
    const { testDb, instructor, buy, refund } = setup();
    const purchase = buy(10000, daysAgo(5));
    refund(purchase.id, schema.RefundStatus.Approved, 6000, daysAgo(4));

    expect(getRevenueSummary(instructor.id, "30d", testDb)).toMatchObject({
      grossCents: 10000,
      refundsCents: 6000,
    });
  });

  it("ignores requested and declined refunds", () => {
    const { testDb, instructor, buy, refund } = setup();
    const first = buy(10000, daysAgo(5));
    const second = buy(10000, daysAgo(5));
    refund(first.id, schema.RefundStatus.Requested, null, null);
    refund(second.id, schema.RefundStatus.Declined, null, daysAgo(1));

    expect(getRevenueSummary(instructor.id, "30d", testDb)).toEqual({
      grossCents: 20000,
      refundsCents: 0,
      feeCents: 4000,
      netCents: 16000,
      purchaseCount: 2,
    });
  });

  it("leaves out refunds on another instructor's courses", () => {
    const { testDb, instructor, user, course, buy, refund } = setup();
    const other = testDb
      .insert(schema.users)
      .values({
        name: "Other",
        email: "other@example.com",
        role: schema.UserRole.Instructor,
      })
      .returning()
      .get();
    const otherCourse = testDb
      .insert(schema.courses)
      .values({
        title: "Other Course",
        slug: "other-course",
        description: "x",
        salesCopy: "x",
        instructorId: other.id,
        categoryId: course.categoryId,
        status: schema.CourseStatus.Published,
      })
      .returning()
      .get();
    const theirs = testDb
      .insert(schema.purchases)
      .values({
        userId: user.id,
        courseId: otherCourse.id,
        amountPaid: 9000,
        createdAt: daysAgo(5),
      })
      .returning()
      .get();
    buy(10000, daysAgo(5));
    refund(theirs.id, schema.RefundStatus.Approved, 9000, daysAgo(4));

    expect(getRevenueSummary(instructor.id, "30d", testDb)).toMatchObject({
      grossCents: 10000,
      refundsCents: 0,
    });
    expect(getRevenueSummary(null, "30d", testDb)).toMatchObject({
      grossCents: 19000,
      refundsCents: 9000,
    });
  });
});

describe("getRevenueOverTime", () => {
  it("reduces net in the day a refund was approved and leaves the purchase day unchanged", () => {
    const { testDb, instructor, buy, refund } = setup();
    const purchase = buy(10000, daysAgo(10));
    refund(purchase.id, schema.RefundStatus.Approved, 10000, daysAgo(2));

    const { points } = getRevenueOverTime(instructor.id, "30d", testDb);
    const day = (ago: number) =>
      points.find((point) => point.bucket === daysAgo(ago).slice(0, 10));

    expect(day(10)).toMatchObject({ grossCents: 10000, netCents: 8000 });
    expect(day(2)).toMatchObject({
      grossCents: 0,
      refundsCents: 10000,
      netCents: -8000,
    });
  });
});

describe("getCourseRevenue", () => {
  it("shows refunds per course, in the period they were approved", () => {
    const { testDb, instructor, course, buy, refund } = setup();
    const purchase = buy(10000, daysAgo(5));
    refund(purchase.id, schema.RefundStatus.Approved, 10000, daysAgo(1));

    expect(getCourseRevenue(instructor.id, "30d", testDb)).toEqual([
      {
        courseId: course.id,
        title: "Test Course",
        grossCents: 10000,
        refundsCents: 10000,
        feeCents: 0,
        netCents: 0,
        purchaseCount: 1,
      },
    ]);
  });

  it("lists a course whose only activity in the range is a refund", () => {
    const { testDb, instructor, buy, refund } = setup();
    const purchase = buy(10000, daysAgo(20));
    refund(purchase.id, schema.RefundStatus.Approved, 10000, daysAgo(2));

    expect(getCourseRevenue(instructor.id, "7d", testDb)).toMatchObject([
      { grossCents: 0, refundsCents: 10000, purchaseCount: 0 },
    ]);
  });
});

describe("getStudentRevenue", () => {
  it("subtracts a student's approved refunds from what they paid", () => {
    const { testDb, instructor, user, course, buy, refund } = setup();
    testDb
      .insert(schema.enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    const purchase = buy(10000, daysAgo(5));
    refund(purchase.id, schema.RefundStatus.Approved, 4000, daysAgo(2));

    expect(getStudentRevenue(instructor.id, "30d", testDb)).toEqual([
      { userId: user.id, name: "Test User", revenueCents: 6000 },
    ]);
  });

  it("subtracts a refund even when it was approved outside the range", () => {
    const { testDb, instructor, user, course, buy, refund } = setup();
    testDb
      .insert(schema.enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    const purchase = buy(10000, daysAgo(60));
    refund(purchase.id, schema.RefundStatus.Approved, 10000, daysAgo(50));

    expect(getStudentRevenue(instructor.id, "7d", testDb)).toEqual([
      { userId: user.id, name: "Test User", revenueCents: 0 },
    ]);
  });

  it("is unchanged by requested and declined refunds", () => {
    const { testDb, instructor, user, course, buy, refund } = setup();
    testDb
      .insert(schema.enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    const first = buy(10000, daysAgo(5));
    const second = buy(2000, daysAgo(5));
    refund(first.id, schema.RefundStatus.Requested, null, null);
    refund(second.id, schema.RefundStatus.Declined, null, daysAgo(1));

    expect(getStudentRevenue(instructor.id, "30d", testDb)).toEqual([
      { userId: user.id, name: "Test User", revenueCents: 12000 },
    ]);
  });
});

describe("getStudentRevenue and team purchases", () => {
  it("leaves an unclaimed team purchase's refund out of every student's total", () => {
    const { testDb, instructor, user, course, buy, refund } = setup();
    testDb
      .insert(schema.enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    buy(10000, daysAgo(5));
    const teamPurchase = buy(30000, daysAgo(5));
    const team = testDb.insert(schema.teams).values({}).returning().get();
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code: "SEAT-1",
        purchaseId: teamPurchase.id,
      })
      .run();
    refund(teamPurchase.id, schema.RefundStatus.Approved, 30000, daysAgo(2));

    // Not attributed to a student when bought, so not subtracted when refunded.
    expect(getStudentRevenue(instructor.id, "30d", testDb)).toEqual([
      { userId: user.id, name: "Test User", revenueCents: 10000 },
    ]);
  });
});

describe("getTopBuyers", () => {
  it("subtracts a buyer's approved refunds from their spend", () => {
    const { testDb, instructor, user, buy, refund } = setup();
    const purchase = buy(10000, daysAgo(5));
    refund(purchase.id, schema.RefundStatus.Approved, 4000, daysAgo(2));

    expect(getTopBuyers(instructor.id, "30d", testDb)).toMatchObject([
      { userId: user.id, spendCents: 6000, purchaseCount: 1 },
    ]);
  });

  it("ranks by spend after refunds", () => {
    const { testDb, instructor, user, buy, refund } = setup();
    const other = testDb
      .insert(schema.users)
      .values({
        name: "Other Buyer",
        email: "buyer@example.com",
        role: schema.UserRole.Student,
      })
      .returning()
      .get();
    const big = buy(10000, daysAgo(5));
    buy(7000, daysAgo(5), other.id);
    refund(big.id, schema.RefundStatus.Approved, 10000, daysAgo(2));

    const buyers = getTopBuyers(instructor.id, "30d", testDb);
    expect(buyers.map((buyer) => [buyer.userId, buyer.spendCents])).toEqual([
      [other.id, 7000],
      [user.id, 0],
    ]);
  });

  it("is unchanged by requested and declined refunds", () => {
    const { testDb, instructor, buy, refund } = setup();
    const first = buy(10000, daysAgo(5));
    const second = buy(2000, daysAgo(5));
    refund(first.id, schema.RefundStatus.Requested, null, null);
    refund(second.id, schema.RefundStatus.Declined, null, daysAgo(1));

    expect(getTopBuyers(instructor.id, "30d", testDb)).toMatchObject([
      { spendCents: 12000 },
    ]);
  });
});

describe("getCourseRevenueByCountry", () => {
  function sale(
    testDb: ReturnType<typeof createTestDb>,
    userId: number,
    courseId: number,
    country: string,
    createdAt: string
  ) {
    return testDb
      .insert(schema.purchases)
      .values({ userId, courseId, amountPaid: 10000, country, createdAt })
      .returning()
      .get();
  }

  it("subtracts a refund in the country of its purchase, using the same fee rule", () => {
    const { testDb, user, course, refund } = setup();
    const us = sale(testDb, user.id, course.id, "US", daysAgo(5));
    sale(testDb, user.id, course.id, "DE", daysAgo(5));
    refund(us.id, schema.RefundStatus.Approved, 10000, daysAgo(2));

    const result = getCourseRevenueByCountry(course.id, "30d", testDb);
    const row = (country: string) =>
      result.rows.find((r) => r.country === country);

    expect(row("US")).toMatchObject({
      grossCents: 10000,
      refundsCents: 10000,
      netCents: 0,
    });
    expect(row("DE")).toMatchObject({ refundsCents: 0, netCents: 8000 });
    expect(result).toMatchObject({
      grossCents: 20000,
      refundsCents: 10000,
      netCents: 8000,
    });
  });

  it("counts a refund in the period it was approved", () => {
    const { testDb, user, course, refund } = setup();
    const old = sale(testDb, user.id, course.id, "US", daysAgo(20));
    refund(old.id, schema.RefundStatus.Approved, 10000, daysAgo(2));

    const result = getCourseRevenueByCountry(course.id, "7d", testDb);
    expect(result.rows).toMatchObject([
      {
        country: "US",
        grossCents: 0,
        refundsCents: 10000,
        purchaseCount: 0,
        averagePaidCents: 0,
        netCents: -8000,
      },
    ]);
  });

  it("ignores requested and declined refunds", () => {
    const { testDb, user, course, refund } = setup();
    const purchase = sale(testDb, user.id, course.id, "US", daysAgo(5));
    refund(purchase.id, schema.RefundStatus.Declined, null, daysAgo(1));

    expect(getCourseRevenueByCountry(course.id, "30d", testDb)).toMatchObject({
      refundsCents: 0,
      netCents: 8000,
    });
  });
});
