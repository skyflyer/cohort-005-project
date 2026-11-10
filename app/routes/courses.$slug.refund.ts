import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import {
  courses,
  purchases,
  refunds,
  users,
  RefundStatus,
} from "~/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import {
  REFUND_COMPLETION_LIMIT,
  REFUND_WINDOW_DAYS,
  getRefundableAmount,
  getWatchedSeconds,
  hasApprovedRefundForCourse,
  hasClaimedSeat,
  hasCompletedTooMuch,
  hasOpenRefundRequest,
  isTeamPurchase,
  hasWatchedTooMuch,
  isWithinRefundWindow,
} from "~/lib/refund-rules.server";
import { buildRefundRequestEmail } from "~/lib/refund-requests.server";

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const learner = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!learner) {
    throw data("User not found", { status: 404 });
  }

  const purchase = getLatestPurchase(currentUserId, course.id);

  if (!purchase) {
    throw data("You have not bought this course.", { status: 403 });
  }

  if (hasApprovedRefundForCourse(currentUserId, course.id)) {
    throw data(
      "You have already had a refund for this course, so we cannot accept another refund request for it.",
      { status: 409 }
    );
  }

  if (hasOpenRefundRequest(purchase.id)) {
    throw data("You already have a request open on this purchase.", {
      status: 409,
    });
  }

  // A seat that came out of a team licence, and has been claimed, belongs to
  // the team — the learner cannot hand it back on their own.
  if (hasClaimedSeat(purchase.id)) {
    throw data("A claimed team seat cannot be refunded.", { status: 403 });
  }

  if (!isWithinRefundWindow(purchase.createdAt)) {
    throw data(`The ${REFUND_WINDOW_DAYS}-day window has closed.`, {
      status: 403,
    });
  }

  const watchedSeconds = getWatchedSeconds(currentUserId, course.id);

  if (hasWatchedTooMuch(watchedSeconds)) {
    throw data("You have watched too much of this course to request a refund.", {
      status: 403,
    });
  }

  if (hasCompletedTooMuch(currentUserId, course.id)) {
    throw data(
      `You have completed ${REFUND_COMPLETION_LIMIT * 100}% or more of this course, so we cannot accept a refund request for it.`,
      { status: 403 }
    );
  }

  const isTeam = isTeamPurchase(purchase.id);
  const refundableAmount = getRefundableAmount(
    { ...purchase, isTeamPurchase: isTeam },
    course
  );

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  db.insert(refunds)
    .values({
      purchaseId: purchase.id,
      status: RefundStatus.Requested,
      reason: parsed.data.reason,
    })
    .returning()
    .get();

  const email = buildRefundRequestEmail({
    learnerName: learner.name,
    learnerEmail: learner.email,
    courseTitle: course.title,
    amount: refundableAmount,
    isTeamPurchase: isTeam,
  });

  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return redirect("/settings");
}
