import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { getSeatCodeStatus } from "./seat-codes.server";
import {
  REFUND_PROGRESS_WARNING,
  REFUND_TEAM_PURCHASE_NOTICE,
} from "~/lib/refund-limits";
import { formatPrice } from "~/lib/utils";
import {
  approveRefundRequest,
  buildRefundApprovalEmail,
  buildRefundRequestEmail,
  declineRefundRequest,
  getOpenRefundRequests,
  requestRefund,
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

  return {
    testDb,
    user,
    instructor,
    course,
    admin,
    lesson,
    purchase,
    request,
    watch,
  };
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
      {
        refundId: refund.id,
        adminId: admin.id,
        declineMessage: "  Too far in.  ",
      },
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
    isTeamPurchase: false,
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

// A learner with a course full of progress, quiz work, a rating, a comment and
// watch history, plus a second course whose data must survive an approval.
function setupApproval() {
  const base = setup();
  const { testDb, user, instructor, course, lesson, purchase } = base;

  testDb
    .insert(schema.enrollments)
    .values({ userId: user.id, courseId: course.id })
    .run();

  const otherCourse = testDb
    .insert(schema.courses)
    .values({
      title: "Other Course",
      slug: "other-course",
      description: "Another",
      salesCopy: "Copy",
      instructorId: instructor.id,
      categoryId: course.categoryId,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
  const otherModule = testDb
    .insert(schema.modules)
    .values({ courseId: otherCourse.id, title: "OM", position: 1 })
    .returning()
    .get();
  const otherLesson = testDb
    .insert(schema.lessons)
    .values({ moduleId: otherModule.id, title: "OL", position: 1 })
    .returning()
    .get();
  testDb
    .insert(schema.enrollments)
    .values({ userId: user.id, courseId: otherCourse.id })
    .run();

  const addProgress = (lessonId: number) =>
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: user.id,
        lessonId,
        status: schema.LessonProgressStatus.Completed,
      })
      .run();
  const addQuizAttempt = (lessonId: number) => {
    const quiz = testDb
      .insert(schema.quizzes)
      .values({ lessonId, title: "Q", passingScore: 0.5 })
      .returning()
      .get();
    const question = testDb
      .insert(schema.quizQuestions)
      .values({
        quizId: quiz.id,
        questionText: "?",
        questionType: schema.QuestionType.TrueFalse,
        position: 1,
      })
      .returning()
      .get();
    const option = testDb
      .insert(schema.quizOptions)
      .values({ questionId: question.id, optionText: "True", isCorrect: true })
      .returning()
      .get();
    const attempt = testDb
      .insert(schema.quizAttempts)
      .values({ userId: user.id, quizId: quiz.id, score: 1, passed: true })
      .returning()
      .get();
    testDb
      .insert(schema.quizAnswers)
      .values({
        attemptId: attempt.id,
        questionId: question.id,
        selectedOptionId: option.id,
      })
      .run();
  };
  const addRating = (courseId: number) =>
    testDb
      .insert(schema.courseRatings)
      .values({ userId: user.id, courseId, rating: 4 })
      .run();

  addProgress(lesson.id);
  addQuizAttempt(lesson.id);
  addRating(course.id);
  testDb
    .insert(schema.comments)
    .values({ lessonId: lesson.id, userId: user.id, body: "Nice lesson" })
    .run();
  base.watch(600, "2026-11-02T10:00:00.000Z");

  addProgress(otherLesson.id);
  addQuizAttempt(otherLesson.id);
  addRating(otherCourse.id);

  const team = testDb.insert(schema.teams).values({}).returning().get();
  const seat = (code: string, redeemedBy?: number) =>
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code,
        purchaseId: purchase.id,
        redeemedByUserId: redeemedBy,
        redeemedAt: redeemedBy ? LATER : undefined,
      })
      .run();

  return { ...base, otherCourse, seat };
}

describe("approveRefundRequest", () => {
  it("deletes the learner's enrollment, progress, quiz work and rating for the course only", () => {
    const { testDb, admin, course, otherCourse, request } = setupApproval();
    const refund = request();

    approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb);

    const enrolled = testDb.select().from(schema.enrollments).all();
    expect(enrolled.map((e) => e.courseId)).toEqual([otherCourse.id]);
    expect(testDb.select().from(schema.lessonProgress).all()).toHaveLength(1);
    expect(testDb.select().from(schema.quizAttempts).all()).toHaveLength(1);
    expect(testDb.select().from(schema.quizAnswers).all()).toHaveLength(1);
    const ratings = testDb.select().from(schema.courseRatings).all();
    expect(ratings.map((r) => r.courseId)).toEqual([otherCourse.id]);
    expect(ratings.map((r) => r.courseId)).not.toContain(course.id);
  });

  it("keeps the learner's watch history and comments", () => {
    const { testDb, admin, request } = setupApproval();
    const refund = request();

    approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb);

    expect(testDb.select().from(schema.videoWatchEvents).all()).toHaveLength(1);
    expect(testDb.select().from(schema.comments).all()).toHaveLength(1);
  });

  it("marks the refund approved with who, when and the refunded amount", () => {
    const { testDb, admin, request } = setupApproval();
    const refund = request();

    approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb);

    const after = testDb.select().from(schema.refunds).get();
    expect(after).toMatchObject({
      status: schema.RefundStatus.Approved,
      resolvedByUserId: admin.id,
      amountRefunded: 10000,
    });
    expect(after?.resolvedAt).toEqual(expect.any(String));
  });

  it("refunds the amount paid for a purchase made at a purchasing-power price", () => {
    const { testDb, admin, purchase, request } = setupApproval();
    testDb
      .update(schema.purchases)
      .set({ country: "IN", amountPaid: 4000 })
      .where(eq(schema.purchases.id, purchase.id))
      .run();
    const refund = request();

    approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb);

    expect(testDb.select().from(schema.refunds).get()?.amountRefunded).toBe(
      4000
    );
  });

  it("refunds the list price for a purchase made at full price", () => {
    const { testDb, admin, purchase, request } = setupApproval();
    testDb
      .update(schema.purchases)
      .set({ country: "US", amountPaid: 9000 })
      .where(eq(schema.purchases.id, purchase.id))
      .run();
    const refund = request();

    approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb);

    expect(testDb.select().from(schema.refunds).get()?.amountRefunded).toBe(
      10000
    );
  });

  it("voids unredeemed seat codes and keeps their rows", () => {
    const { testDb, admin, seat, request } = setupApproval();
    seat("UNUSED-1");
    seat("UNUSED-2");
    const refund = request();

    approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb);

    const codes = testDb.select().from(schema.coupons).all();
    expect(codes).toHaveLength(2);
    for (const code of codes) {
      expect(getSeatCodeStatus(code)).toMatchObject({
        redeemable: false,
        reason: "voided",
      });
    }
  });

  it("reports an already-resolved request as resolved even if a seat was claimed", () => {
    const { testDb, admin, instructor, seat, request } = setupApproval();
    seat("CLAIMED-1", instructor.id);
    const refund = request(schema.RefundStatus.Declined);

    expect(() =>
      approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb)
    ).toThrow(
      expect.objectContaining({
        data: "This refund request has already been resolved.",
      })
    );
  });

  it("refuses when a seat was claimed and changes nothing", () => {
    const { testDb, admin, instructor, seat, request } = setupApproval();
    seat("UNUSED-1");
    seat("CLAIMED-1", instructor.id);
    const refund = request();

    expect(() =>
      approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb)
    ).toThrow();

    expect(testDb.select().from(schema.refunds).get()?.status).toBe(
      schema.RefundStatus.Requested
    );
    expect(testDb.select().from(schema.enrollments).all()).toHaveLength(2);
    expect(testDb.select().from(schema.lessonProgress).all()).toHaveLength(2);
    expect(testDb.select().from(schema.coupons).all()).toHaveLength(2);
  });

  it("rolls everything back if a step fails part-way", () => {
    const { testDb, admin, request } = setupApproval();
    // Make the last delete fail, after the earlier ones have already run.
    testDb.run(
      sql`CREATE TRIGGER fail_enrollment_delete BEFORE DELETE ON enrollments BEGIN SELECT RAISE(ABORT, 'boom'); END`
    );
    const refund = request();

    expect(() =>
      approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb)
    ).toThrow();

    expect(testDb.select().from(schema.refunds).get()?.status).toBe(
      schema.RefundStatus.Requested
    );
    expect(testDb.select().from(schema.lessonProgress).all()).toHaveLength(2);
    expect(testDb.select().from(schema.quizAnswers).all()).toHaveLength(2);
    expect(testDb.select().from(schema.courseRatings).all()).toHaveLength(2);
  });

  it("rejects a request that is not open", () => {
    const { testDb, admin, request } = setupApproval();
    const refund = request(schema.RefundStatus.Declined);

    expect(() =>
      approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb)
    ).toThrow();
    expect(testDb.select().from(schema.enrollments).all()).toHaveLength(2);
  });

  it("cannot be applied twice", () => {
    const { testDb, admin, request } = setupApproval();
    const refund = request();
    approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb);

    expect(() =>
      approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb)
    ).toThrow();
  });

  it("returns an approval email saying the progress was deleted", () => {
    const { testDb, user, course, admin, request } = setupApproval();
    const refund = request();

    const { email } = approveRefundRequest(
      { refundId: refund.id, adminId: admin.id },
      testDb
    );

    expect(email.to).toBe(user.email);
    expect(email.subject).toContain(course.title);
    expect(email.body).toContain(formatPrice(10000));
    expect(email.body).toMatch(/progress/i);
  });
});

describe("buildRefundRequestEmail for a team purchase", () => {
  const email = buildRefundRequestEmail({
    learnerName: "Sam",
    learnerEmail: "sam@example.com",
    courseTitle: "Design Systems",
    amount: 45000,
    isTeamPurchase: true,
  });

  it("does not warn about progress deletion", () => {
    expect(email.body).not.toContain(REFUND_PROGRESS_WARNING);
    expect(email.body).not.toContain("progress");
  });

  it("explains that unused seat codes stop working", () => {
    expect(email.body).toContain(REFUND_TEAM_PURCHASE_NOTICE);
    expect(email.body).toContain(formatPrice(45000));
  });
});

describe("buildRefundApprovalEmail", () => {
  const input = {
    learnerName: "Sam",
    learnerEmail: "sam@example.com",
    courseTitle: "Design Systems",
    amount: 4900,
  };

  it("says access ended and progress was deleted for a solo purchase", () => {
    const email = buildRefundApprovalEmail({ ...input, isTeamPurchase: false });
    expect(email.body).toContain("progress for it has been deleted");
  });

  it("does not mention progress for a team purchase", () => {
    const email = buildRefundApprovalEmail({ ...input, isTeamPurchase: true });
    expect(email.body).not.toContain("progress");
    expect(email.body).not.toContain("access to the course has ended");
    expect(email.body).toContain("seat codes");
  });
});

describe("approveRefundRequest for a team purchase", () => {
  function setupTeam() {
    const base = setupApproval();
    base.testDb
      .update(schema.purchases)
      .set({ amountPaid: 45000 })
      .where(eq(schema.purchases.id, base.purchase.id))
      .run();
    base.seat("UNUSED-1");
    base.seat("UNUSED-2");
    return base;
  }

  it("leaves the buyer's enrollment, progress, quiz data and rating alone", () => {
    const { testDb, admin, request } = setupTeam();
    const refund = request();

    approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb);

    expect(testDb.select().from(schema.enrollments).all()).toHaveLength(2);
    expect(testDb.select().from(schema.lessonProgress).all()).toHaveLength(2);
    expect(testDb.select().from(schema.quizAttempts).all()).toHaveLength(2);
    expect(testDb.select().from(schema.quizAnswers).all()).toHaveLength(2);
    expect(testDb.select().from(schema.courseRatings).all()).toHaveLength(2);
  });

  it("voids the unredeemed seat codes and records the refund at what was paid", () => {
    const { testDb, admin, request } = setupTeam();
    const refund = request();

    approveRefundRequest({ refundId: refund.id, adminId: admin.id }, testDb);

    for (const code of testDb.select().from(schema.coupons).all()) {
      expect(getSeatCodeStatus(code)).toMatchObject({ reason: "voided" });
    }
    expect(testDb.select().from(schema.refunds).get()).toMatchObject({
      status: schema.RefundStatus.Approved,
      amountRefunded: 45000,
    });
  });

  it("returns an email that does not mention progress", () => {
    const { testDb, admin, request } = setupTeam();
    const refund = request();

    const { email } = approveRefundRequest(
      { refundId: refund.id, adminId: admin.id },
      testDb
    );

    expect(email.body).not.toContain("progress");
    expect(email.body).toContain(formatPrice(45000));
  });
});

describe("getOpenRefundRequests for a team purchase", () => {
  it("shows what was paid, flags it as a team purchase and counts no progress to delete", () => {
    const { testDb, purchase, seat, request } = setupApproval();
    testDb
      .update(schema.purchases)
      .set({ amountPaid: 45000 })
      .where(eq(schema.purchases.id, purchase.id))
      .run();
    seat("UNUSED-1");
    request();

    expect(getOpenRefundRequests(testDb)[0]).toMatchObject({
      isTeamPurchase: true,
      refundableAmount: 45000,
      lessonsWithProgress: 0,
    });
  });

  it("flags a solo purchase as not a team purchase", () => {
    const { testDb, request } = setupApproval();
    request();

    expect(getOpenRefundRequests(testDb)[0].isTeamPurchase).toBe(false);
  });
});

describe("getOpenRefundRequests approval details", () => {
  it("counts the lessons with progress in the refunded course only", () => {
    const { testDb, request } = setupApproval();
    request();

    expect(getOpenRefundRequests(testDb)[0].lessonsWithProgress).toBe(1);
  });

  it("flags a request whose team seat has been claimed", () => {
    const { testDb, instructor, seat, request } = setupApproval();
    request();
    expect(getOpenRefundRequests(testDb)[0].hasClaimedSeat).toBe(false);

    seat("CLAIMED-1", instructor.id);

    expect(getOpenRefundRequests(testDb)[0].hasClaimedSeat).toBe(true);
  });
});

describe("requestRefund", () => {
  const reason = "It was not what I expected.";

  function setupRequest() {
    const base = setup();
    const { testDb, user, course } = base;
    // Read the purchase fresh, so changes a test makes to it are seen.
    const ask = () => {
      const current = testDb.select().from(schema.purchases).get();
      if (!current) throw new Error("purchase missing");
      return requestRefund(
        { learner: user, course, purchaseId: current.id, reason },
        testDb
      );
    };
    return { ...base, ask };
  }

  it("records an open request and returns the request email", () => {
    const { testDb, purchase, ask } = setupRequest();
    // inside the window: the purchase was made just now
    testDb
      .update(schema.purchases)
      .set({ createdAt: new Date().toISOString() })
      .where(eq(schema.purchases.id, purchase.id))
      .run();

    const { email } = ask();

    expect(testDb.select().from(schema.refunds).get()).toMatchObject({
      purchaseId: purchase.id,
      status: schema.RefundStatus.Requested,
      reason,
    });
    expect(email.body).toContain(REFUND_PROGRESS_WARNING);
  });

  it("refuses with a 403 at or above 50% completion", () => {
    const { testDb, user, lesson, purchase, ask } = setupRequest();
    testDb
      .update(schema.purchases)
      .set({ createdAt: new Date().toISOString() })
      .where(eq(schema.purchases.id, purchase.id))
      .run();
    // the only lesson is completed: 100%
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: user.id,
        lessonId: lesson.id,
        status: schema.LessonProgressStatus.Completed,
      })
      .run();

    expect(() => ask()).toThrow(expect.objectContaining({ init: { status: 403 } }));
    expect(testDb.select().from(schema.refunds).all()).toHaveLength(0);
  });

  it("sends the team email at amountPaid for a team purchase", () => {
    const { testDb, course, purchase, ask } = setupRequest();
    testDb
      .update(schema.purchases)
      .set({ createdAt: new Date().toISOString(), amountPaid: 45000 })
      .where(eq(schema.purchases.id, purchase.id))
      .run();
    const team = testDb.insert(schema.teams).values({}).returning().get();
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code: "SEAT-1",
        purchaseId: purchase.id,
      })
      .run();

    const { email } = ask();

    expect(email.body).toContain(formatPrice(45000));
    expect(email.body).toContain(REFUND_TEAM_PURCHASE_NOTICE);
    expect(email.body).not.toContain(REFUND_PROGRESS_WARNING);
  });
});

describe("requestRefund eligibility rules", () => {
  function setupEligible() {
    const base = setup();
    const { testDb, user, course, purchase } = base;
    testDb
      .update(schema.purchases)
      .set({ createdAt: new Date().toISOString() })
      .where(eq(schema.purchases.id, purchase.id))
      .run();
    const ask = () => {
      const current = testDb.select().from(schema.purchases).get();
      if (!current) throw new Error("purchase missing");
      return requestRefund(
        {
          learner: user,
          course,
          purchaseId: current.id,
          reason: "It was not what I expected.",
        },
        testDb
      );
    };
    const refused = (status: number) =>
      expect.objectContaining({ init: expect.objectContaining({ status }) });
    return { ...base, ask, refused };
  }

  it("refuses with a 409 when the learner already had a refund for the course", () => {
    const { testDb, user, course, request, ask, refused } = setupEligible();
    // an earlier purchase of the same course, refunded
    const earlier = testDb
      .insert(schema.purchases)
      .values({ userId: user.id, courseId: course.id, amountPaid: 9000 })
      .returning()
      .get();
    testDb
      .insert(schema.refunds)
      .values({
        purchaseId: earlier.id,
        status: schema.RefundStatus.Approved,
        reason: "Earlier refund.",
      })
      .run();
    request();

    expect(() => ask()).toThrow(refused(409));
  });

  it("refuses with a 409 when the purchase already has an open request", () => {
    const { request, ask, refused } = setupEligible();
    request();

    expect(() => ask()).toThrow(refused(409));
  });

  it("refuses with a 403 when a team seat was claimed", () => {
    const { testDb, instructor, course, purchase, ask, refused } =
      setupEligible();
    const team = testDb.insert(schema.teams).values({}).returning().get();
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code: "CLAIMED-1",
        purchaseId: purchase.id,
        redeemedByUserId: instructor.id,
        redeemedAt: LATER,
      })
      .run();

    expect(() => ask()).toThrow(refused(403));
  });

  it("refuses with a 403 outside the refund window", () => {
    const { testDb, purchase, ask, refused } = setupEligible();
    testDb
      .update(schema.purchases)
      .set({ createdAt: "2020-01-01T10:00:00.000Z" })
      .where(eq(schema.purchases.id, purchase.id))
      .run();

    expect(() => ask()).toThrow(refused(403));
  });

  it("refuses with a 403 when the learner watched 2 hours or more", () => {
    const { watch, ask, refused } = setupEligible();
    watch(2 * 60 * 60, new Date().toISOString());

    expect(() => ask()).toThrow(refused(403));
  });
});

describe("requestRefund for a named purchase", () => {
  const reason = "It was not what I expected.";

  function setupTwoPurchases() {
    const base = setup();
    const { testDb, user, instructor, course, lesson, purchase: solo } = base;
    const now = new Date().toISOString();
    testDb
      .update(schema.purchases)
      .set({ createdAt: now })
      .where(eq(schema.purchases.id, solo.id))
      .run();

    const teamPurchase = (seats = 3, createdAt = now) => {
      const team = testDb.insert(schema.teams).values({}).returning().get();
      const bought = testDb
        .insert(schema.purchases)
        .values({
          userId: user.id,
          courseId: course.id,
          amountPaid: 9000 * seats,
          country: "US",
          createdAt,
        })
        .returning()
        .get();
      const codes = Array.from({ length: seats }, (_, i) =>
        testDb
          .insert(schema.coupons)
          .values({
            teamId: team.id,
            courseId: course.id,
            code: `T${bought.id}-${i}`,
            purchaseId: bought.id,
          })
          .returning()
          .get()
      );
      return { purchase: bought, codes };
    };

    const ask = (purchaseId: number, learner = user) =>
      requestRefund({ learner, course, purchaseId, reason }, testDb);
    const refused = (status: number) =>
      expect.objectContaining({ init: expect.objectContaining({ status }) });
    const completeAndWatch = () => {
      testDb
        .insert(schema.lessonProgress)
        .values({
          userId: user.id,
          lessonId: lesson.id,
          status: schema.LessonProgressStatus.Completed,
        })
        .run();
      testDb
        .insert(schema.videoWatchEvents)
        .values({
          userId: user.id,
          lessonId: lesson.id,
          eventType: "pause",
          positionSeconds: 3 * 60 * 60,
        })
        .run();
    };
    return {
      ...base,
      solo,
      teamPurchase,
      ask,
      refused,
      completeAndWatch,
      otherUser: instructor,
    };
  }

  it("refunds a team purchase despite 100% completion and over 2 hours watched", () => {
    const { testDb, teamPurchase, ask, completeAndWatch } = setupTwoPurchases();
    const { purchase } = teamPurchase();
    completeAndWatch();

    const { email } = ask(purchase.id);

    expect(email.body).toContain(REFUND_TEAM_PURCHASE_NOTICE);
    expect(
      testDb
        .select()
        .from(schema.refunds)
        .where(eq(schema.refunds.purchaseId, purchase.id))
        .all()
    ).toHaveLength(1);
  });

  it("still refuses a solo purchase at the completion and watch limits", () => {
    const { solo, ask, completeAndWatch, refused } = setupTwoPurchases();
    completeAndWatch();

    expect(() => ask(solo.id)).toThrow(refused(403));
  });

  it("lets a buyer with only a team purchase request a refund", () => {
    const { testDb, solo, teamPurchase, ask } = setupTwoPurchases();
    const { purchase } = teamPurchase();
    testDb.delete(schema.purchases).where(eq(schema.purchases.id, solo.id)).run();

    expect(() => ask(purchase.id)).not.toThrow();
  });

  it("lets a buyer with both purchases refund either one independently", () => {
    const { testDb, solo, teamPurchase, ask } = setupTwoPurchases();
    const { purchase: team } = teamPurchase();

    ask(team.id);
    ask(solo.id);

    expect(testDb.select().from(schema.refunds).all()).toHaveLength(2);
  });

  it("refuses a purchase that is not the learner's", () => {
    const { solo, ask, otherUser, refused } = setupTwoPurchases();

    expect(() => ask(solo.id, otherUser)).toThrow(refused(403));
  });

  it("refuses a purchase of another course", () => {
    const { testDb, user, instructor, course, solo, ask, refused } =
      setupTwoPurchases();
    const other = testDb
      .insert(schema.courses)
      .values({
        title: "Other",
        slug: "other",
        description: "d",
        salesCopy: "Sales copy.",
        instructorId: instructor.id,
        categoryId: course.categoryId,
        status: schema.CourseStatus.Published,
        price: 5000,
      })
      .returning()
      .get();
    const otherPurchase = testDb
      .insert(schema.purchases)
      .values({ userId: user.id, courseId: other.id, amountPaid: 5000 })
      .returning()
      .get();

    expect(() => ask(otherPurchase.id)).toThrow(refused(403));
    expect(() => ask(99999)).toThrow(refused(403));
    expect(solo.id).not.toBe(otherPurchase.id);
  });

  it("refuses a team purchase with a claimed seat", () => {
    const { testDb, instructor, teamPurchase, ask, refused } =
      setupTwoPurchases();
    const { purchase, codes } = teamPurchase();
    testDb
      .update(schema.coupons)
      .set({ redeemedByUserId: instructor.id, redeemedAt: LATER })
      .where(eq(schema.coupons.id, codes[0].id))
      .run();

    expect(() => ask(purchase.id)).toThrow(refused(403));
  });

  it("refuses a team purchase outside the refund window", () => {
    const { teamPurchase, ask, refused } = setupTwoPurchases();
    const { purchase } = teamPurchase(2, "2020-01-01T10:00:00.000Z");

    expect(() => ask(purchase.id)).toThrow(refused(403));
  });

  it("refuses a second request on a team purchase that is already open or refunded", () => {
    const { testDb, teamPurchase, ask, refused } = setupTwoPurchases();
    const { purchase } = teamPurchase();

    ask(purchase.id);
    expect(() => ask(purchase.id)).toThrow(refused(409));

    testDb
      .update(schema.refunds)
      .set({ status: schema.RefundStatus.Approved })
      .where(eq(schema.refunds.purchaseId, purchase.id))
      .run();
    expect(() => ask(purchase.id)).toThrow(refused(409));
  });

  it("does not let a refunded team purchase block a refund of the solo purchase", () => {
    const { testDb, solo, teamPurchase, ask } = setupTwoPurchases();
    const { purchase: team } = teamPurchase();
    testDb
      .insert(schema.refunds)
      .values({
        purchaseId: team.id,
        status: schema.RefundStatus.Approved,
        reason,
      })
      .run();

    expect(() => ask(solo.id)).not.toThrow();
  });

  it("does not let a refunded solo purchase block a refund of a team purchase", () => {
    const { testDb, solo, teamPurchase, ask } = setupTwoPurchases();
    const { purchase: team } = teamPurchase();
    testDb
      .insert(schema.refunds)
      .values({
        purchaseId: solo.id,
        status: schema.RefundStatus.Approved,
        reason,
      })
      .run();

    expect(() => ask(team.id)).not.toThrow();
  });
});
