import { eq } from "drizzle-orm";
import { Knock } from "@knocklabs/node";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { alias } from "drizzle-orm/sqlite-core";
import {
  comments,
  coupons,
  courses,
  lessons,
  modules,
  purchases,
  refunds,
  RefundStatus,
  UserRole,
  users,
} from "~/db/schema";

// ─── Notifications ───
// One `notify*` function per Notification (see GLOSSARY.md), delivered through
// Knock into the Notification Feed. Knock is the only store; Cadence keeps no
// notification tables. See docs/knock-setup.md for the Knock-side setup.
//
// Every `notify*` takes the database first, the relevant entity ids, and a
// NotificationSender (defaults to defaultSender()). Each one loads what it
// needs, picks recipients, leaves out the actor, and makes ONE trigger call
// (none if nobody is left). Failures never escape: they are logged and
// swallowed, so a Notification can never break the action that caused it.
//
// To add a Notification: add its payload to NotificationData, call
// `deliver(...)` from a new `notify*` function, and test it with a recording
// sender (see notifications.server.test.ts).

// React Router dev doesn't load .env into process.env, so do it here.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: defaultSender() falls back to logging
}

type Db = BetterSQLite3Database<typeof schema>;

// ─── Types ───

export type WorkflowKey =
  | "refund-request-approved"
  | "refund-request-declined"
  | "refund-request-opened"
  | "seat-claimed"
  | "new-enrollment"
  | "discussion-question"
  | "discussion-reply";

// id = String(users.id). Never carries an email or a role.
export type Recipient = { id: string; name: string; avatar: string | null };

type Common = {
  actorName: string;
  actorAvatar: string | null;
  courseTitle: string;
  // Where clicking the Notification goes.
  url: string;
};

// The Feed renders rows from `data` only. `kind` equals the workflow key.
// Later tickets fill in the non-discussion payloads as they build them.
export type NotificationData =
  | ({ kind: "discussion-question" | "discussion-reply" } & Common & {
        lessonTitle: string;
        excerpt: string;
      })
  | ({ kind: "refund-request-approved" | "refund-request-declined" } & Common & {
        reason: string | null;
        decisionNote: string | null;
        amountCents: number;
      })
  | ({ kind: "refund-request-opened" } & Common & {
        reason: string | null;
        amountCents: number;
      })
  | ({ kind: "seat-claimed" } & Common & { seatsLeft: number })
  | ({ kind: "new-enrollment" } & Common);

export interface NotificationSender {
  trigger(
    workflowKey: WorkflowKey,
    payload: {
      actor: Recipient;
      recipients: Recipient[];
      data: NotificationData;
    },
    options: { idempotencyKey: string }
  ): Promise<void>;
}

// ─── Senders ───

export function knockSender(secretKey: string): NotificationSender {
  const knock = new Knock({ apiKey: secretKey, timeout: 3000, maxRetries: 1 });
  const identify = (r: Recipient) => ({
    id: r.id,
    name: r.name,
    avatar: r.avatar,
  });
  return {
    async trigger(workflowKey, payload, options) {
      await knock.workflows.trigger(
        workflowKey,
        {
          actor: identify(payload.actor),
          recipients: payload.recipients.map(identify),
          data: payload.data,
        },
        { idempotencyKey: options.idempotencyKey }
      );
    },
  };
}

export const logSender: NotificationSender = {
  async trigger(workflowKey, payload, options) {
    console.info(
      `[notifications] ${workflowKey} -> ${payload.recipients
        .map((r) => r.id)
        .join(",")} (${options.idempotencyKey})`
    );
  },
};

export function defaultSender(): NotificationSender {
  const secretKey = process.env.KNOCK_SECRET_API_KEY;
  return secretKey ? knockSender(secretKey) : logSender;
}

// ─── Shared helpers ───

function toRecipient(user: {
  id: number;
  name: string;
  avatarUrl: string | null;
}): Recipient {
  return { id: String(user.id), name: user.name, avatar: user.avatarUrl };
}

// Sends one trigger, or none when nobody is left after leaving out the actor.
// Never rejects.
async function deliver(
  sender: NotificationSender,
  workflowKey: WorkflowKey,
  entityId: number,
  actor: Recipient,
  recipients: Recipient[],
  data: NotificationData
) {
  const others = recipients.filter((r) => r.id !== actor.id);
  if (others.length === 0) return;

  const idempotencyKey = `${workflowKey}:${entityId}`;
  try {
    await sender.trigger(
      workflowKey,
      { actor, recipients: others, data },
      { idempotencyKey }
    );
  } catch (error) {
    console.error(
      `[notifications] trigger failed: ${workflowKey}`,
      `idempotencyKey=${idempotencyKey}`,
      error
    );
  }
}

const EXCERPT_LENGTH = 140;

function excerptOf(body: string) {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LENGTH
    ? `${flat.slice(0, EXCERPT_LENGTH - 1)}…`
    : flat;
}

// ─── Discussions ───

function loadComment(db: Db, commentId: number) {
  return db
    .select({
      id: comments.id,
      body: comments.body,
      parentId: comments.parentId,
      lessonId: comments.lessonId,
      lessonTitle: lessons.title,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      instructorId: courses.instructorId,
      authorId: users.id,
      authorName: users.name,
      authorAvatar: users.avatarUrl,
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .innerJoin(lessons, eq(comments.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(comments.id, commentId))
    .get();
}

function getUser(db: Db, id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

async function notifyDiscussion(
  db: Db,
  commentId: number,
  kind: "discussion-question" | "discussion-reply",
  sender: NotificationSender
) {
  const comment = loadComment(db, commentId);
  if (!comment) return;

  let recipientId: number;
  if (kind === "discussion-question") {
    recipientId = comment.instructorId;
  } else {
    const parent = comment.parentId
      ? loadComment(db, comment.parentId)
      : undefined;
    if (!parent) return;
    recipientId = parent.authorId;
  }
  const recipient = getUser(db, recipientId);
  if (!recipient) return;

  const actor = toRecipient({
    id: comment.authorId,
    name: comment.authorName,
    avatarUrl: comment.authorAvatar,
  });

  await deliver(sender, kind, comment.id, actor, [toRecipient(recipient)], {
    kind,
    actorName: actor.name,
    actorAvatar: actor.avatar,
    courseTitle: comment.courseTitle,
    lessonTitle: comment.lessonTitle,
    excerpt: excerptOf(comment.body),
    url: `/courses/${comment.courseSlug}/lessons/${comment.lessonId}`,
  });
}

// A new comment with no parent is a Discussion Question (-> the course's
// Instructor). One with a parent is a Discussion Reply (-> the question's
// author).
export async function notifyDiscussionQuestion(
  db: Db,
  commentId: number,
  sender: NotificationSender = defaultSender()
) {
  await notifyDiscussion(db, commentId, "discussion-question", sender);
}

export async function notifyDiscussionReply(
  db: Db,
  commentId: number,
  sender: NotificationSender = defaultSender()
) {
  await notifyDiscussion(db, commentId, "discussion-reply", sender);
}

// The comment entry point: decides between the two. Call after the insert
// commits.
export async function notifyComment(
  db: Db,
  commentId: number,
  sender: NotificationSender = defaultSender()
) {
  const comment = db
    .select({ parentId: comments.parentId })
    .from(comments)
    .where(eq(comments.id, commentId))
    .get();
  if (!comment) return;

  if (comment.parentId === null) {
    await notifyDiscussionQuestion(db, commentId, sender);
  } else {
    await notifyDiscussionReply(db, commentId, sender);
  }
}

// ─── Refund Requests (#48) ───

function loadRefundRequest(db: Db, refundRequestId: number) {
  const decider = alias(users, "decider");
  const row = db
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      decisionNote: refunds.decisionNote,
      amountRefunded: refunds.amountRefunded,
      purchaseId: purchases.id,
      amountPaid: purchases.amountPaid,
      courseTitle: courses.title,
      buyerId: users.id,
      buyerName: users.name,
      buyerAvatar: users.avatarUrl,
      deciderId: decider.id,
      deciderName: decider.name,
      deciderAvatar: decider.avatarUrl,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .leftJoin(decider, eq(refunds.resolvedByUserId, decider.id))
    .where(eq(refunds.id, refundRequestId))
    .get();
  if (!row) return undefined;

  // A Team Licence is the Purchase that granted Seats.
  const seat = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, row.purchaseId))
    .get();
  return { ...row, isTeamLicence: seat !== undefined };
}

// Call after an approve or decline commits. The buyer (the Student, or the
// Team Admin for a Team Licence) is the recipient; the deciding Platform
// Admin is the actor.
export async function notifyRefundRequestDecided(
  db: Db,
  refundRequestId: number,
  sender: NotificationSender = defaultSender()
) {
  const refund = loadRefundRequest(db, refundRequestId);
  if (!refund || refund.deciderId === null || refund.deciderName === null) {
    return;
  }

  let kind: "refund-request-approved" | "refund-request-declined";
  if (refund.status === RefundStatus.Approved) kind = "refund-request-approved";
  else if (refund.status === RefundStatus.Declined)
    kind = "refund-request-declined";
  else return;

  const actor = toRecipient({
    id: refund.deciderId,
    name: refund.deciderName,
    avatarUrl: refund.deciderAvatar,
  });
  const buyer = toRecipient({
    id: refund.buyerId,
    name: refund.buyerName,
    avatarUrl: refund.buyerAvatar,
  });

  await deliver(sender, kind, refund.id, actor, [buyer], {
    kind,
    actorName: actor.name,
    actorAvatar: actor.avatar,
    courseTitle: refund.courseTitle,
    reason: refund.reason,
    decisionNote: refund.decisionNote,
    amountCents: refund.amountRefunded ?? refund.amountPaid,
    url: refund.isTeamLicence ? "/team" : "/settings",
  });
}

// Call after a Refund Request is raised. Every Platform Admin (read from the
// database now) is notified; `deliver` leaves out the buyer.
export async function notifyRefundRequestOpened(
  db: Db,
  refundRequestId: number,
  sender: NotificationSender = defaultSender()
) {
  const refund = loadRefundRequest(db, refundRequestId);
  if (!refund) return;

  const actor = toRecipient({
    id: refund.buyerId,
    name: refund.buyerName,
    avatarUrl: refund.buyerAvatar,
  });
  const admins = db
    .select()
    .from(users)
    .where(eq(users.role, UserRole.Admin))
    .all()
    .map(toRecipient);

  await deliver(sender, "refund-request-opened", refund.id, actor, admins, {
    kind: "refund-request-opened",
    actorName: actor.name,
    actorAvatar: actor.avatar,
    courseTitle: refund.courseTitle,
    reason: refund.reason,
    amountCents: refund.amountPaid,
    url: "/admin/refunds",
  });
}
