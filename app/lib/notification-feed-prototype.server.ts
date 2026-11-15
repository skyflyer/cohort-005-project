// PROTOTYPE — "What does the Notification Feed look like in Cadence?" (#36).
// Throwaway; lives only on prototype/notification-feed. Never merge.
import { eq, ne } from "drizzle-orm";
import { db } from "~/db";
import { courses, lessons, modules, users } from "~/db/schema";
import {
  knock,
  signTokenFor,
  KNOCK_PUBLIC_API_KEY,
  KNOCK_FEED_CHANNEL_ID,
  WORKFLOW_DISCUSSION_REPLY,
} from "~/lib/knock-prototype.server";

export async function getFeedAuth(user: { id: number; name: string; email: string }) {
  await knock.users.update(String(user.id), { name: user.name, email: user.email } as never);
  return {
    token: await signTokenFor(user.id),
    publicKey: KNOCK_PUBLIC_API_KEY,
    channelId: KNOCK_FEED_CHANNEL_ID,
  };
}

// Sends one of each catalogue Notification (from "Which Notifications does
// Cadence send, and to whom?") to the current user, regardless of role.
// Shortcut: only `discussions-reply` exists in Knock, so every kind rides that
// workflow and our UI renders from `data` (we never use Knock's template).
export async function seedCatalogue(userId: number) {
  const me = db.select().from(users).where(eq(users.id, userId)).get()!;
  const other = db.select().from(users).where(ne(users.id, userId)).all();
  const pick = (i: number) => other[i % other.length];
  const row = db
    .select({
      courseId: courses.id,
      courseTitle: courses.title,
      slug: courses.slug,
      lessonId: lessons.id,
      lessonTitle: lessons.title,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .get()!;
  const course = row.courseTitle;
  const lessonUrl = `/courses/${row.slug}/lessons/${row.lessonId}`;

  const catalogue: { actor: typeof me; data: Record<string, unknown> }[] = [
    {
      actor: pick(0),
      data: { kind: "refund-approved", course, url: `/courses/${row.slug}` },
    },
    {
      actor: pick(1),
      data: {
        kind: "refund-declined",
        course,
        reason: "You've completed over 80% of the course.",
        url: `/courses/${row.slug}`,
      },
    },
    {
      actor: pick(2),
      data: {
        kind: "open-refund-request",
        course,
        reason: "The course wasn't what I expected.",
        url: "/admin/refunds",
      },
    },
    {
      actor: pick(3),
      data: { kind: "seat-claimed", course, seatsLeft: 3, url: "/team" },
    },
    {
      actor: pick(4),
      data: {
        kind: "new-enrollment",
        course,
        url: `/instructor/${row.courseId}/students`,
      },
    },
    {
      actor: pick(5),
      data: {
        kind: "discussion-question",
        course,
        lesson: row.lessonTitle,
        excerpt: "Why does the loader run again after every action? I expected it to cache.",
        url: lessonUrl,
      },
    },
    {
      actor: pick(6),
      data: {
        kind: "discussion-reply",
        course,
        lesson: row.lessonTitle,
        excerpt: "Revalidation is on purpose: after a mutation React Router refetches so the UI can't go stale.",
        url: lessonUrl,
      },
    },
  ];

  for (const n of catalogue) {
    await knock.workflows.trigger(WORKFLOW_DISCUSSION_REPLY, {
      recipients: [String(userId)],
      actor: { id: String(n.actor.id), name: n.actor.name, email: n.actor.email } as never,
      data: { ...n.data, actor_name: n.actor.name, actor_avatar: n.actor.avatarUrl },
    });
  }
  return catalogue.length;
}
