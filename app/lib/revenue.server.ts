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
import type { SQL } from "drizzle-orm";
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
import { getDiscountForCountry } from "~/lib/ppp";

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
type Granularity = "day" | "month";

/** sum() is null over an empty set, and a string when SQLite has rows. */
function cents(value: unknown): number {
  return Number(value ?? 0);
}

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
function revenueFigures(grossCents: number, refundsCents: number): RevenueFigures {
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

/**
 * Approved refunds joined to their purchase and course, narrowed by
 * `condition`, as a subquery to select from. The one place that decides which
 * refunds count: only approved ones, with `amountRefunded` as the money given
 * back.
 */
function approvedRefunds(database: Database, condition: SQL | undefined) {
  return database
    .select({
      amount: refunds.amountRefunded,
      resolvedAt: refunds.resolvedAt,
      userId: purchases.userId,
      country: purchases.country,
      courseId: courses.id,
      title: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(and(eq(refunds.status, RefundStatus.Approved), condition))
    .as("approved_refunds");
}

/** Refunds dated by approval — never by the purchase they give back. */
function approvedRefundScope(
  instructorId: number | null,
  range: AnalyticsRange
) {
  return scopeOn(refunds.resolvedAt, instructorId, range);
}

// ─── Summary ───

export function getRevenueSummary(
  instructorId: number | null,
  range: AnalyticsRange,
  database: Database = db
): RevenueFigures & { purchaseCount: number } {
  const salesRow = database
    .select({
      gross: sum(purchases.amountPaid),
      purchaseCount: count(purchases.id),
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(purchaseScope(instructorId, range))
    .get();

  const approved = approvedRefunds(
    database,
    approvedRefundScope(instructorId, range)
  );
  const refundRow = database
    .select({ refunded: sum(approved.amount) })
    .from(approved)
    .get();

  // sum() returns null over an empty set, and a string when SQLite has rows.
  return {
    ...revenueFigures(cents(salesRow?.gross), cents(refundRow?.refunded)),
    purchaseCount: salesRow?.purchaseCount ?? 0,
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
  const salesRows = database
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

  const approved = approvedRefunds(
    database,
    approvedRefundScope(instructorId, range)
  );
  const refundRows = database
    .select({
      courseId: approved.courseId,
      title: approved.title,
      refunded: sum(approved.amount),
    })
    .from(approved)
    .groupBy(approved.courseId)
    .all();

  const byCourse = new Map<
    number,
    { title: string; gross: number; refunded: number; purchaseCount: number }
  >();

  for (const row of salesRows) {
    byCourse.set(row.courseId, {
      title: row.title,
      gross: cents(row.gross),
      refunded: 0,
      purchaseCount: row.purchaseCount,
    });
  }
  for (const row of refundRows) {
    const entry = byCourse.get(row.courseId) ?? {
      title: row.title,
      gross: 0,
      refunded: 0,
      purchaseCount: 0,
    };
    entry.refunded = cents(row.refunded);
    byCourse.set(row.courseId, entry);
  }

  return [...byCourse.entries()]
    .map(([courseId, entry]) => ({
      courseId,
      title: entry.title,
      ...revenueFigures(entry.gross, entry.refunded),
      purchaseCount: entry.purchaseCount,
    }))
    .sort((a, b) => b.grossCents - a.grossCents);
}

// ─── Over time ───

export type RevenuePoint = RevenueFigures & { bucket: string };

export type RevenueSeries = {
  granularity: Granularity;
  points: RevenuePoint[];
};

/** The bucket an ISO timestamp falls in, at the given granularity. */
function bucketOf(iso: string, granularity: Granularity): string {
  return iso.slice(0, granularity === "day" ? 10 : 7);
}

/** Every bucket from `first` to `last` inclusive, with none skipped. */
function bucketRange(
  first: string,
  last: string,
  granularity: Granularity
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
  const approved = approvedRefunds(
    database,
    approvedRefundScope(instructorId, range)
  );
  const refundBucket = sql<string>`substr(${approved.resolvedAt}, 1, ${length})`;

  const salesRows = database
    .select({ bucket: purchaseBucket, gross: sum(purchases.amountPaid) })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(purchaseScope(instructorId, range))
    .groupBy(purchaseBucket)
    .all();

  const refundRows = database
    .select({ bucket: refundBucket, refunded: sum(approved.amount) })
    .from(approved)
    .groupBy(refundBucket)
    .all();

  const grossByBucket = new Map(
    salesRows.map((row) => [row.bucket, cents(row.gross)])
  );
  const refundsByBucket = new Map(
    refundRows.map((row) => [row.bucket, cents(row.refunded)])
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
    ...revenueFigures(grossByBucket.get(bucket) ?? 0, refundsByBucket.get(bucket) ?? 0),
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

  // A team purchase can only be refunded while no seat has been claimed, and
  // an unclaimed one is not attributed to any student's paid total — so its
  // refund is rightly absent from the per-student figures too.
  const approved = approvedRefunds(
    database,
    and(
      inArray(purchases.userId, studentIds),
      notExists(mintedSeats),
      ownedBy(instructorId)
    )
  );
  const refunded = database
    .select({ userId: approved.userId, refunded: sum(approved.amount) })
    .from(approved)
    .groupBy(approved.userId)
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
  for (const row of refunded) credit(row.userId, -cents(row.refunded));

  return students.map((student) => ({
    ...student,
    revenueCents: Math.round(paidByUser.get(student.userId) ?? 0),
  }));
}

// ─── Top buyers and countries ───

export type TopBuyer = {
  userId: number;
  name: string;
  email: string;
  spendCents: number;
  purchaseCount: number;
  seatsBought: number;
  seatsUnredeemed: number;
  enrolled: boolean;
};


export type CountryRevenueRow = {
  country: string | null;
  purchaseCount: number;
  grossCents: number;
  refundsCents: number;
  netCents: number;
  sharePercent: number;
  averagePaidCents: number;
  discountPercent: number | null;
};

export type CourseCountryRevenue = {
  grossCents: number;
  refundsCents: number;
  netCents: number;
  purchaseCount: number;
  discountedGrossCents: number;
  discountedNetCents: number;
  discountedSharePercent: number;
  rows: CountryRevenueRow[];
};

const TOP_BUYER_LIMIT = 10;

export function getTopBuyers(
  instructorId: number | null,
  range: AnalyticsRange,
  database: Database = db
): TopBuyer[] {
  const buyerRows = database
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      spend: sum(purchases.amountPaid),
      purchaseCount: count(purchases.id),
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(users, eq(users.id, purchases.userId))
    .where(purchaseScope(instructorId, range))
    .groupBy(users.id)
    .all();

  // What a buyer spent is net of the refunds on those purchases, whenever the
  // refund was approved — so the ranking is by net spend, and happens here
  // rather than in SQL.
  const approved = approvedRefunds(
    database,
    purchaseScope(instructorId, range)
  );
  const refundedByUser = new Map(
    database
      .select({ userId: approved.userId, refunded: sum(approved.amount) })
      .from(approved)
      .groupBy(approved.userId)
      .all()
      .map((row) => [row.userId, cents(row.refunded)])
  );

  const buyers = buyerRows
    .map((buyer) => ({
      ...buyer,
      spend: cents(buyer.spend) - (refundedByUser.get(buyer.userId) ?? 0),
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, TOP_BUYER_LIMIT);

  if (buyers.length === 0) return [];

  const buyerIds = buyers.map((buyer) => buyer.userId);

  // Seats are counted in their own query: joining coupons to purchases above
  // would repeat each purchase once per seat and multiply the spend the
  // leaderboard ranks on.
  const seats = database
    .select({
      userId: purchases.userId,
      bought: count(coupons.id),
      unredeemed: sql<number>`sum(case when ${coupons.redeemedByUserId} is null then 1 else 0 end)`,
    })
    .from(coupons)
    .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        inArray(purchases.userId, buyerIds),
        purchaseScope(instructorId, range)
      )
    )
    .groupBy(purchases.userId)
    .all();

  const seatsByUser = new Map(seats.map((row) => [row.userId, row]));

  // No range here: "never enrolled" is a fact about the person, not about the
  // last thirty days.
  const enrolled = new Set(
    database
      .selectDistinct({ userId: enrollments.userId })
      .from(enrollments)
      .innerJoin(courses, eq(enrollments.courseId, courses.id))
      .where(and(inArray(enrollments.userId, buyerIds), ownedBy(instructorId)))
      .all()
      .map((row) => row.userId)
  );

  return buyers.map((buyer) => ({
    userId: buyer.userId,
    name: buyer.name,
    email: buyer.email,
    spendCents: buyer.spend,
    purchaseCount: buyer.purchaseCount,
    seatsBought: seatsByUser.get(buyer.userId)?.bought ?? 0,
    seatsUnredeemed: Number(seatsByUser.get(buyer.userId)?.unredeemed ?? 0),
    enrolled: enrolled.has(buyer.userId),
  }));
}


export function getCourseRevenueByCountry(
  courseId: number,
  range: AnalyticsRange,
  database: Database = db
): CourseCountryRevenue {
  const salesRows = database
    .select({
      country: purchases.country,
      gross: sum(purchases.amountPaid),
      purchaseCount: count(purchases.id),
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.courseId, courseId),
        sinceRange(purchases.createdAt, range)
      )
    )
    .groupBy(purchases.country)
    .all();

  // A refund belongs to the country of the purchase it gives back, in the
  // period it was approved.
  const approved = approvedRefunds(
    database,
    and(
      eq(purchases.courseId, courseId),
      sinceRange(refunds.resolvedAt, range)
    )
  );
  const refundRows = database
    .select({ country: approved.country, refunded: sum(approved.amount) })
    .from(approved)
    .groupBy(approved.country)
    .all();

  const byCountry = new Map<
    string | null,
    { grossCents: number; refundsCents: number; purchaseCount: number }
  >();
  const entryFor = (country: string | null) => {
    const entry = byCountry.get(country) ?? {
      grossCents: 0,
      refundsCents: 0,
      purchaseCount: 0,
    };
    byCountry.set(country, entry);
    return entry;
  };
  for (const row of salesRows) {
    const entry = entryFor(row.country);
    entry.grossCents = cents(row.gross);
    entry.purchaseCount = row.purchaseCount;
  }
  for (const row of refundRows) {
    entryFor(row.country).refundsCents = cents(row.refunded);
  }

  const rows = [...byCountry.entries()]
    .map(([country, entry]) => ({ country, ...entry }))
    .sort((a, b) => b.grossCents - a.grossCents);

  const grossCents = rows.reduce((total, row) => total + row.grossCents, 0);
  const refundsCents = rows.reduce((total, row) => total + row.refundsCents, 0);
  const purchaseCount = rows.reduce(
    (total, row) => total + row.purchaseCount,
    0
  );

  const share = (amount: number) =>
    grossCents === 0 ? 0 : Math.round((amount / grossCents) * 100);

  let discountedGrossCents = 0;
  let discountedRefundsCents = 0;

  const breakdown = rows.map((row) => {
    const discountPercent =
      row.country === null ? null : getDiscountForCountry(row.country) * 100;

    if (discountPercent !== null && discountPercent > 0) {
      discountedGrossCents += row.grossCents;
      discountedRefundsCents += row.refundsCents;
    }

    return {
      ...row,
      netCents: revenueFigures(row.grossCents, row.refundsCents).netCents,
      sharePercent: share(row.grossCents),
      // A country with only a refund in the range has no purchases to average.
      averagePaidCents:
        row.purchaseCount === 0
          ? 0
          : Math.round(row.grossCents / row.purchaseCount),
      discountPercent,
    };
  });

  return {
    grossCents,
    refundsCents,
    netCents: revenueFigures(grossCents, refundsCents).netCents,
    purchaseCount,
    discountedGrossCents,
    discountedNetCents: revenueFigures(
      discountedGrossCents,
      discountedRefundsCents
    ).netCents,
    discountedSharePercent: share(discountedGrossCents),
    rows: breakdown,
  };
}

