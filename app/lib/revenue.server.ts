import {
  and,
  count,
  eq,
  gte,
  inArray,
  notExists,
  sql,
  sum,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  RefundStatus,
  courses,
  coupons,
  enrollments,
  purchases,
  refunds,
  users,
} from "~/db/schema";
import { rangeStart, splitRevenue, type AnalyticsRange } from "~/lib/analytics";

// ─── Revenue ───
// What was paid and what was given back, for the instructor analytics page.
//
// A purchase counts in the period it was made. A refund counts in the period
// it was approved — never in the period of its purchase — so the figures of a
// past period do not change when a refund is approved later. Requested and
// declined refunds return no money and are ignored.
//
// Functions take the database as a last argument (defaulting to the app
// database) so tests can pass an in-memory one.
type Database = typeof db;

export type RevenueFigures = {
  grossCents: number;
  refundsCents: number;
  feeCents: number;
  netCents: number;
};

/**
 * The platform's fee and the instructor's net are worked out on what is left
 * after refunds: money given back is not revenue the platform keeps a cut of.
 */
function figures(grossCents: number, refundsCents: number): RevenueFigures {
  const { feeCents, netCents } = splitRevenue(grossCents - refundsCents);
  return { grossCents, refundsCents, feeCents, netCents };
}

// ─── Scopes ───

export function scopeOn(
  dateColumn: SQLiteColumn,
  instructorId: number | null,
  range: AnalyticsRange
) {
  const conditions = [];

  if (instructorId !== null) {
    conditions.push(eq(courses.instructorId, instructorId));
  }

  const start = rangeStart(range);
  if (start !== null) {
    conditions.push(gte(dateColumn, start));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

export function purchaseScope(
  instructorId: number | null,
  range: AnalyticsRange
) {
  return scopeOn(purchases.createdAt, instructorId, range);
}

export function sinceRange(dateColumn: SQLiteColumn, range: AnalyticsRange) {
  const start = rangeStart(range);
  return start === null ? undefined : gte(dateColumn, start);
}

export function ownedBy(instructorId: number | null) {
  return instructorId === null
    ? undefined
    : eq(courses.instructorId, instructorId);
}

/** Approved refunds, dated by approval, for the viewer's courses. */
function approvedRefundScope(
  instructorId: number | null,
  range: AnalyticsRange
) {
  return and(
    eq(refunds.status, RefundStatus.Approved),
    scopeOn(refunds.resolvedAt, instructorId, range)
  );
}

// ─── Summary ───

export function getRevenueSummary(
  instructorId: number | null,
  range: AnalyticsRange,
  database: Database = db
): RevenueFigures & { purchaseCount: number } {
  const sales = database
    .select({
      gross: sum(purchases.amountPaid),
      purchaseCount: count(purchases.id),
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(purchaseScope(instructorId, range))
    .get();

  const returned = database
    .select({ refunded: sum(refunds.amountRefunded) })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(approvedRefundScope(instructorId, range))
    .get();

  // sum() returns null over an empty set, and a string when SQLite has rows.
  return {
    ...figures(Number(sales?.gross ?? 0), Number(returned?.refunded ?? 0)),
    purchaseCount: sales?.purchaseCount ?? 0,
  };
}

// ─── By course ───

/**
 * Revenue broken down by course, biggest earner first. A course appears when
 * it sold or refunded anything in the range, and is absent otherwise.
 */
export function getCourseRevenue(
  instructorId: number | null,
  range: AnalyticsRange,
  database: Database = db
) {
  const sold = database
    .select({
      courseId: courses.id,
      title: courses.title,
      gross: sum(purchases.amountPaid),
      purchaseCount: count(purchases.id),
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(purchaseScope(instructorId, range))
    .groupBy(courses.id)
    .all();

  const returned = database
    .select({
      courseId: courses.id,
      title: courses.title,
      refunded: sum(refunds.amountRefunded),
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(approvedRefundScope(instructorId, range))
    .groupBy(courses.id)
    .all();

  const byCourse = new Map<
    number,
    { title: string; gross: number; refunded: number; purchaseCount: number }
  >();

  for (const row of sold) {
    byCourse.set(row.courseId, {
      title: row.title,
      gross: Number(row.gross ?? 0),
      refunded: 0,
      purchaseCount: row.purchaseCount,
    });
  }
  for (const row of returned) {
    const entry = byCourse.get(row.courseId) ?? {
      title: row.title,
      gross: 0,
      refunded: 0,
      purchaseCount: 0,
    };
    entry.refunded = Number(row.refunded ?? 0);
    byCourse.set(row.courseId, entry);
  }

  return [...byCourse.entries()]
    .map(([courseId, entry]) => ({
      courseId,
      title: entry.title,
      ...figures(entry.gross, entry.refunded),
      purchaseCount: entry.purchaseCount,
    }))
    .sort((a, b) => b.grossCents - a.grossCents);
}

// ─── Over time ───

export type RevenuePoint = RevenueFigures & { bucket: string };

export type RevenueSeries = {
  granularity: "day" | "month";
  points: RevenuePoint[];
};

/** The bucket an ISO timestamp falls in, at the given granularity. */
function bucketOf(iso: string, granularity: "day" | "month"): string {
  return iso.slice(0, granularity === "day" ? 10 : 7);
}

/** Every bucket from `first` to `last` inclusive, with none skipped. */
function bucketRange(
  first: string,
  last: string,
  granularity: "day" | "month"
): string[] {
  const buckets: string[] = [];
  const cursor = new Date(
    `${first}${granularity === "day" ? "" : "-01"}T00:00:00.000Z`
  );

  while (bucketOf(cursor.toISOString(), granularity) <= last) {
    buckets.push(bucketOf(cursor.toISOString(), granularity));
    if (granularity === "day") {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } else {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  return buckets;
}

export function getRevenueOverTime(
  instructorId: number | null,
  range: AnalyticsRange,
  database: Database = db
): RevenueSeries {
  const granularity = range === "all" ? "month" : "day";
  const length = granularity === "day" ? 10 : 7;
  const purchaseBucket = sql<string>`substr(${purchases.createdAt}, 1, ${length})`;
  const refundBucket = sql<string>`substr(${refunds.resolvedAt}, 1, ${length})`;

  const sales = database
    .select({ bucket: purchaseBucket, gross: sum(purchases.amountPaid) })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(purchaseScope(instructorId, range))
    .groupBy(purchaseBucket)
    .all();

  const returned = database
    .select({ bucket: refundBucket, refunded: sum(refunds.amountRefunded) })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(approvedRefundScope(instructorId, range))
    .groupBy(refundBucket)
    .all();

  const grossByBucket = new Map(
    sales.map((row) => [row.bucket, Number(row.gross ?? 0)])
  );
  const refundsByBucket = new Map(
    returned.map((row) => [row.bucket, Number(row.refunded ?? 0)])
  );

  const firstBucket = [...grossByBucket.keys(), ...refundsByBucket.keys()].sort()[0];
  if (firstBucket === undefined && range === "all") {
    return { granularity, points: [] };
  }

  const now = new Date().toISOString();
  // A fixed range always spans its whole window, even before the first sale;
  // all time can only start where the data does.
  const start = rangeStart(range) ?? firstBucket;

  const points = bucketRange(
    bucketOf(start, granularity),
    bucketOf(now, granularity),
    granularity
  ).map((bucket) => ({
    bucket,
    ...figures(grossByBucket.get(bucket) ?? 0, refundsByBucket.get(bucket) ?? 0),
  }));

  return { granularity, points };
}

// ─── By student ───

export type StudentRevenue = {
  userId: number;
  name: string;
  revenueCents: number;
};

/**
 * What each enrolled student paid, less their approved refunds. The refunds
 * are not narrowed to the range: what someone has paid is a fact about the
 * person, and always net of what was given back.
 */
export function getStudentRevenue(
  instructorId: number | null,
  range: AnalyticsRange,
  database: Database = db
): StudentRevenue[] {
  const students = database
    .selectDistinct({ userId: users.id, name: users.name })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(scopeOn(enrollments.enrolledAt, instructorId, range))
    .orderBy(users.name)
    .all();

  if (students.length === 0) return [];

  const studentIds = students.map((student) => student.userId);

  // Correlated: did this purchase mint seats for other people?
  const mintedSeats = database
    .select({ one: sql`1` })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchases.id));

  const direct = database
    .select({ userId: purchases.userId, paid: sum(purchases.amountPaid) })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        inArray(purchases.userId, studentIds),
        notExists(mintedSeats),
        ownedBy(instructorId)
      )
    )
    .groupBy(purchases.userId)
    .all();

  const refunded = database
    .select({ userId: purchases.userId, refunded: sum(refunds.amountRefunded) })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        eq(refunds.status, RefundStatus.Approved),
        inArray(purchases.userId, studentIds),
        notExists(mintedSeats),
        ownedBy(instructorId)
      )
    )
    .groupBy(purchases.userId)
    .all();

  const seatCounts = database
    .select({ purchaseId: coupons.purchaseId, seats: count().as("seats") })
    .from(coupons)
    .groupBy(coupons.purchaseId)
    .as("seat_counts");

  const viaSeat = database
    .select({
      userId: coupons.redeemedByUserId,
      // Divided rather than rounded per row: the shares are summed first and
      // rounded once, so five seats out of 3333 cents still add up.
      paid: sql<number>`sum(${purchases.amountPaid} * 1.0 / ${seatCounts.seats})`,
    })
    .from(coupons)
    .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(seatCounts, eq(seatCounts.purchaseId, coupons.purchaseId))
    .where(
      and(inArray(coupons.redeemedByUserId, studentIds), ownedBy(instructorId))
    )
    .groupBy(coupons.redeemedByUserId)
    .all();

  const paidByUser = new Map<number, number>();
  const credit = (userId: number | null, paid: unknown) => {
    if (userId === null) return;
    paidByUser.set(userId, (paidByUser.get(userId) ?? 0) + Number(paid ?? 0));
  };

  for (const row of direct) credit(row.userId, row.paid);
  for (const row of viaSeat) credit(row.userId, row.paid);
  for (const row of refunded) credit(row.userId, -Number(row.refunded ?? 0));

  return students.map((student) => ({
    ...student,
    revenueCents: Math.round(paidByUser.get(student.userId) ?? 0),
  }));
}
