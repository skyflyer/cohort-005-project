import { data } from "react-router";
import { and, asc, eq } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  purchases,
  refunds,
  RefundStatus,
  users,
} from "~/db/schema";
import {
  getRefundableAmount,
  getWatchedSeconds,
  hasWatchedTooMuch,
} from "~/lib/refund-rules.server";

// Takes the database as a last argument (defaulting to the app database) so tests can pass an in-memory one.
type Database = typeof db;

/**
 * Every refund request still waiting for a decision, oldest first, with what
 * an admin needs to decide: the watch time when the learner asked and the
 * watch time now. Nothing here blocks a request — the admin decides.
 */
export function getOpenRefundRequests(database: Database = db) {
  const rows = database
    .select({
      id: refunds.id,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      purchasedAt: purchases.createdAt,
      amountPaid: purchases.amountPaid,
      country: purchases.country,
      coursePrice: courses.price,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, RefundStatus.Requested))
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all();

  return rows.map((row) => {
    const watchedSecondsNow = getWatchedSeconds(
      row.learnerId,
      row.courseId,
      database
    );
    return {
      id: row.id,
      learnerName: row.learnerName,
      learnerEmail: row.learnerEmail,
      courseTitle: row.courseTitle,
      purchasedAt: row.purchasedAt,
      refundableAmount: getRefundableAmount(
        { amountPaid: row.amountPaid, country: row.country },
        { price: row.coursePrice }
      ),
      reason: row.reason,
      requestedAt: row.requestedAt,
      watchedSecondsAtRequest: getWatchedSeconds(
        row.learnerId,
        row.courseId,
        database,
        row.requestedAt
      ),
      watchedSecondsNow,
      watchedTooMuchNow: hasWatchedTooMuch(watchedSecondsNow),
    };
  });
}

/**
 * The email the learner gets when their refund request is declined. There is
 * no mail transport wired up yet, so the caller logs the built message.
 */
export function buildRefundDeclineEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  declineMessage: string;
}) {
  return {
    to: input.learnerEmail,
    subject: `Refund request declined — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have reviewed your refund request for "${input.courseTitle}" and we are not able to approve it.`,
      "",
      input.declineMessage,
      "",
      "Your access to the course and your progress have not changed.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

/**
 * Declines an open refund request with a decline message. Records who
 * resolved it and when; touches nothing else, so the learner keeps their
 * enrollment and progress. Returns the decline email for the caller to send.
 */
export function declineRefundRequest(
  input: { refundId: number; adminId: number; declineMessage: string },
  database: Database = db
) {
  const declineMessage = input.declineMessage.trim();

  if (declineMessage === "") {
    throw data("A decline message is required.", { status: 400 });
  }

  const refund = database
    .select({
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
      status: refunds.status,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, input.refundId))
    .get();

  if (!refund) {
    throw data("Refund request not found", { status: 404 });
  }

  if (refund.status !== RefundStatus.Requested) {
    throw data("This refund request has already been resolved.", {
      status: 409,
    });
  }

  database
    .update(refunds)
    .set({
      status: RefundStatus.Declined,
      declineMessage,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: input.adminId,
    })
    .where(
      and(
        eq(refunds.id, input.refundId),
        eq(refunds.status, RefundStatus.Requested)
      )
    )
    .run();

  return {
    email: buildRefundDeclineEmail({
      learnerName: refund.learnerName,
      learnerEmail: refund.learnerEmail,
      courseTitle: refund.courseTitle,
      declineMessage,
    }),
  };
}
