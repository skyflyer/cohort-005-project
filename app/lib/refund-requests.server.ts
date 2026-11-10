import { data } from "react-router";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courses,
  purchases,
  refunds,
  RefundStatus,
  users,
} from "~/db/schema";
import {
  getRefundableAmount,
  hasClaimedSeat,
  isTeamPurchase,
  getWatchedSeconds,
  hasWatchedTooMuch,
} from "~/lib/refund-rules.server";
import {
  countLessonsWithProgress,
  deleteLearnerCourseData,
} from "~/lib/learner-course-data.server";
import type { Database, DatabaseReader } from "~/lib/database-types";
import {
  REFUND_PROGRESS_WARNING,
  REFUND_TEAM_PURCHASE_NOTICE,
} from "~/lib/refund-limits";
import { formatPrice } from "~/lib/utils";

// Both the review list and the decline action start from a refund joined to
// its purchase, learner and course. Takes anything that can select, so it
// also works on the transaction handle.
function selectRefundsWithContext(reader: DatabaseReader) {
  return reader
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      coursePrice: courses.price,
      purchaseId: purchases.id,
      purchasedAt: purchases.createdAt,
      amountPaid: purchases.amountPaid,
      country: purchases.country,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id));
}

/**
 * Every refund request still waiting for a decision, oldest first, with what
 * an admin needs to decide: the watch time when the learner asked and the
 * watch time now. Nothing here blocks a request — the admin decides.
 */
export function getOpenRefundRequests(database: Database = db) {
  const rows = selectRefundsWithContext(database)
    .where(eq(refunds.status, RefundStatus.Requested))
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all();

  return rows.map((row) => {
    const isTeam = isTeamPurchase(row.purchaseId, database);
    const currentWatchedSeconds = getWatchedSeconds(
      row.learnerId,
      row.courseId,
      undefined,
      database
    );
    return {
      id: row.id,
      learnerName: row.learnerName,
      learnerEmail: row.learnerEmail,
      courseTitle: row.courseTitle,
      purchasedAt: row.purchasedAt,
      refundableAmount: getRefundableAmount(
        {
          amountPaid: row.amountPaid,
          country: row.country,
          isTeamPurchase: isTeam,
        },
        { price: row.coursePrice }
      ),
      isTeamPurchase: isTeam,
      reason: row.reason,
      requestedAt: row.requestedAt,
      watchedSecondsAtRequest: getWatchedSeconds(
        row.learnerId,
        row.courseId,
        row.requestedAt,
        database
      ),
      currentWatchedSeconds,
      isOverWatchLimitNow: hasWatchedTooMuch(currentWatchedSeconds),
      // A team purchase never deletes the buyer's own progress.
      lessonsWithProgress: isTeam
        ? 0
        : countLessonsWithProgress(row.learnerId, row.courseId, database),
      hasClaimedSeat: hasClaimedSeat(row.purchaseId, database),
    };
  });
}

/**
 * The confirmation the learner gets in their inbox. There is no mail
 * transport wired up yet, so the built message goes to the server log.
 */
export function buildRefundRequestEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
  isTeamPurchase: boolean;
}) {
  return {
    to: input.learnerEmail,
    subject: `Refund request received — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your refund request for "${input.courseTitle}".`,
      `The refund would be ${formatPrice(input.amount)}, the amount you paid.`,
      "",
      input.isTeamPurchase
        ? REFUND_TEAM_PURCHASE_NOTICE
        : REFUND_PROGRESS_WARNING,
      "",
      "Our team reviews every refund request by hand. You do not need to do anything else — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
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

  // Read and update in one transaction, and only update a row that is still
  // open, so two admins resolving the same request cannot both succeed.
  const refund = database.transaction((tx) => {
    const found = selectRefundsWithContext(tx)
      .where(eq(refunds.id, input.refundId))
      .get();

    if (!found) {
      throw data("Refund request not found", { status: 404 });
    }

    const updated = tx
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

    if (updated.changes !== 1) {
      throw data("This refund request has already been resolved.", {
        status: 409,
      });
    }

    return found;
  });

  return {
    email: buildRefundDeclineEmail({
      learnerName: refund.learnerName,
      learnerEmail: refund.learnerEmail,
      courseTitle: refund.courseTitle,
      declineMessage,
    }),
  };
}

/**
 * The email the learner gets when their refund request is approved. There is
 * no mail transport wired up yet, so the caller logs the built message.
 */
export function buildRefundApprovalEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
  isTeamPurchase: boolean;
}) {
  return {
    to: input.learnerEmail,
    subject: `Refund approved — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `Your refund request for "${input.courseTitle}" has been approved.`,
      `We are refunding ${formatPrice(input.amount)} to your card.`,
      "",
      input.isTeamPurchase
        ? "The seat codes from this purchase that nobody had used yet no longer work. Your own access to the course has not changed."
        : "As we warned when you asked, your access to the course has ended and your progress for it has been deleted.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

/**
 * Approves an open refund request (ADR 0001). In one transaction: marks the
 * refund approved at the refundable amount, and for a solo purchase deletes
 * the learner's enrollment, lesson progress, quiz attempts and answers, and
 * rating for the course. A team purchase leaves the buyer's own data alone.
 * It also voids the purchase's unredeemed seat codes so they stop working.
 * Watch history and comments are kept. Refused if a seat was claimed.
 * Returns the approval email for the caller to send.
 */
export function approveRefundRequest(
  input: { refundId: number; adminId: number },
  database: Database = db
) {
  const refund = database.transaction((tx) => {
    const found = selectRefundsWithContext(tx)
      .where(eq(refunds.id, input.refundId))
      .get();

    if (!found) {
      throw data("Refund request not found", { status: 404 });
    }

    // Resolved requests are reported as such before anything else.
    if (found.status !== RefundStatus.Requested) {
      throw data("This refund request has already been resolved.", {
        status: 409,
      });
    }

    if (hasClaimedSeat(found.purchaseId, tx)) {
      throw data(
        "A team seat on this purchase has been claimed, so the refund cannot be approved.",
        { status: 409 }
      );
    }

    const isTeam = isTeamPurchase(found.purchaseId, tx);
    const amountRefunded = getRefundableAmount(
      {
        amountPaid: found.amountPaid,
        country: found.country,
        isTeamPurchase: isTeam,
      },
      { price: found.coursePrice }
    );

    // Only update a row that is still open, so two admins resolving the same
    // request cannot both succeed.
    const updated = tx
      .update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded,
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

    if (updated.changes !== 1) {
      throw data("This refund request has already been resolved.", {
        status: 409,
      });
    }

    // A team purchase never gave the buyer an enrollment, so their own
    // access and progress (perhaps from a separate solo purchase) stay.
    if (!isTeam) {
      deleteLearnerCourseData(tx, found.learnerId, found.courseId);
    }

    // Void rather than delete: the rows record that this purchase minted
    // seats. No seat was claimed (checked above), so all of them are unredeemed.
    tx.update(coupons)
      .set({ voidedAt: new Date().toISOString() })
      .where(
        and(eq(coupons.purchaseId, found.purchaseId), isNull(coupons.voidedAt))
      )
      .run();

    return { ...found, amountRefunded, isTeam };
  });

  return {
    email: buildRefundApprovalEmail({
      learnerName: refund.learnerName,
      learnerEmail: refund.learnerEmail,
      courseTitle: refund.courseTitle,
      amount: refund.amountRefunded,
      isTeamPurchase: refund.isTeam,
    }),
  };
}
