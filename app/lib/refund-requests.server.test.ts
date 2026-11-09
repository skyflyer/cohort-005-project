import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { REFUND_PROGRESS_WARNING } from "~/lib/refund-limits";
import { formatPrice } from "~/lib/utils";
import {
  buildRefundRequestEmail,
  declineRefundRequest,
  getOpenRefundRequests,
} from "./refund-requests.server";

const BOUGHT = "2026-11-01T10:00:00.000Z";
const REQUESTED = "2026-11-03T10:00:00.000Z";
const LATER = "2026-11-05T10:00:00.000Z";

function setup() {
  const testDb = createTestDb();
  const { user, instructor, course } = seedBaseData(testDb);
  testDb
    .update(schema.courses)
    .set({ price: 10000 })
    .where(eq(schema.courses.id, course.id))
    .run();

  const admin = testDb
    .insert(schema.users)
    .values({
      name: "Ada Admin",
      email: "admin@example.com",
      role: schema.UserRole.Admin,
    })
    .returning()
    .get();

  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: course.id, title: "M", position: 1 })
    .returning()
    .get();
  const lesson = testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "L", position: 1 })
    .returning()
    .get();

  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: user.id,
      courseId: course.id,
      amountPaid: 9000,
      country: "US",
      createdAt: BOUGHT,
    })
    .returning()
    .get();

  const request = (status = schema.RefundStatus.Requested) =>
    testDb
      .insert(schema.refunds)
      .values({
        purchaseId: purchase.id,
        status,
        reason: "It was not what I expected.",
        requestedAt: REQUESTED,
      })
      .returning()
      .get();

  const watch = (positionSeconds: number, createdAt: string) =>
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

  return { testDb, user, instructor, course, admin, lesson, purchase, request, watch };
}

describe("getOpenRefundRequests", () => {
  it("shows what the admin needs to decide, with watch time at request and now", () => {
    const { testDb, user, course, purchase, request, watch } = setup();
    request();
    watch(600, "2026-11-02T10:00:00.000Z");
    watch(8000, LATER);

    const [row] = getOpenRefundRequests(testDb);

    expect(row).toMatchObject({
      learnerName: user.name,
      courseTitle: course.title,
      purchasedAt: purchase.createdAt,
      refundableAmount: 10000,
      reason: "It was not what I expected.",
      watchedSecondsAtRequest: 600,
      currentWatchedSeconds: 8000,
      isOverWatchLimitNow: true,
    });
  });

  it("does not warn below two hours of current watch time", () => {
    const { testDb, request, watch } = setup();
    request();
    watch(7199, LATER);

    expect(getOpenRefundRequests(testDb)[0].isOverWatchLimitNow).toBe(false);
  });

  it("leaves out requests that are already resolved", () => {
    const { testDb, request } = setup();
    request(schema.RefundStatus.Declined);
    request(schema.RefundStatus.Approved);

    expect(getOpenRefundRequests(testDb)).toEqual([]);
  });
});

describe("declineRefundRequest", () => {
  it("marks the request declined and stores the decline message", () => {
    const { testDb, admin, request } = setup();
    const refund = request();

    declineRefundRequest(
      { refundId: refund.id, adminId: admin.id, declineMessage: "  Too far in.  " },
      testDb
    );

    const after = testDb
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, refund.id))
      .get();
    expect(after).toMatchObject({
      status: schema.RefundStatus.Declined,
      declineMessage: "Too far in.",
      resolvedByUserId: admin.id,
      amountRefunded: null,
    });
    expect(after?.resolvedAt).toEqual(expect.any(String));
    expect(getOpenRefundRequests(testDb)).toEqual([]);
  });

  it("returns the decline email, carrying the decline message", () => {
    const { testDb, user, course, admin, request } = setup();
    const refund = request();

    const { email } = declineRefundRequest(
      { refundId: refund.id, adminId: admin.id, declineMessage: "Too far in." },
      testDb
    );

    expect(email.to).toBe(user.email);
    expect(email.subject).toContain(course.title);
    expect(email.body).toContain("Too far in.");
  });

  it("rejects a blank decline message and leaves the request open", () => {
    const { testDb, admin, request } = setup();
    const refund = request();

    expect(() =>
      declineRefundRequest(
        { refundId: refund.id, adminId: admin.id, declineMessage: "   " },
        testDb
      )
    ).toThrow();
    expect(getOpenRefundRequests(testDb)).toHaveLength(1);
  });

  it("rejects a request that is not open", () => {
    const { testDb, admin, request } = setup();
    const refund = request(schema.RefundStatus.Approved);

    expect(() =>
      declineRefundRequest(
        { refundId: refund.id, adminId: admin.id, declineMessage: "No." },
        testDb
      )
    ).toThrow();
  });

  it("rejects a request that does not exist", () => {
    const { testDb, admin } = setup();

    expect(() =>
      declineRefundRequest(
        { refundId: 999, adminId: admin.id, declineMessage: "No." },
        testDb
      )
    ).toThrow();
  });

  it("leaves the learner's enrollment and progress untouched", () => {
    const { testDb, user, course, admin, lesson, request } = setup();
    testDb
      .insert(schema.enrollments)
      .values({ userId: user.id, courseId: course.id })
      .run();
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: user.id,
        lessonId: lesson.id,
        status: schema.LessonProgressStatus.Completed,
      })
      .run();
    const refund = request();

    declineRefundRequest(
      { refundId: refund.id, adminId: admin.id, declineMessage: "Too far in." },
      testDb
    );

    expect(testDb.select().from(schema.enrollments).all()).toHaveLength(1);
    expect(testDb.select().from(schema.lessonProgress).all()).toHaveLength(1);
  });
});

describe("declineRefundRequest when the request is resolved meanwhile", () => {
  it("does not overwrite an earlier decision", () => {
    const { testDb, admin, request } = setup();
    const refund = request();
    declineRefundRequest(
      { refundId: refund.id, adminId: admin.id, declineMessage: "First." },
      testDb
    );

    expect(() =>
      declineRefundRequest(
        { refundId: refund.id, adminId: admin.id, declineMessage: "Second." },
        testDb
      )
    ).toThrow();
    const after = testDb.select().from(schema.refunds).get();
    expect(after?.declineMessage).toBe("First.");
  });
});

describe("buildRefundRequestEmail", () => {
  const email = buildRefundRequestEmail({
    learnerName: "Sam",
    learnerEmail: "sam@example.com",
    courseTitle: "Design Systems",
    amount: 4900,
  });

  it("is addressed to the learner", () => {
    expect(email.to).toBe("sam@example.com");
  });

  it("warns that approval removes access and deletes progress", () => {
    expect(email.body).toContain(REFUND_PROGRESS_WARNING);
    expect(email.body).toContain("lose access");
  });

  it("states the refundable amount", () => {
    expect(email.body).toContain(formatPrice(4900));
  });
});
