import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  notifyComment,
  notifyDiscussionQuestion,
  notifyDiscussionReply,
  type NotificationSender,
} from "./notifications.server";

type TestDb = ReturnType<typeof createTestDb>;
type Trigger = Parameters<NotificationSender["trigger"]>;

function recordingSender() {
  const calls: Trigger[] = [];
  const sender: NotificationSender = {
    async trigger(...args) {
      calls.push(args);
    },
  };
  return { sender, calls };
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;
let admin: typeof schema.users.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  admin = db
    .insert(schema.users)
    .values({ name: "Pat Admin", email: "pat@example.com", role: UserRole.Admin })
    .returning()
    .get();
  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  lessonId = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Intro Lesson", position: 1 })
    .returning()
    .get().id;
});

function addComment(userId: number, body: string, parentId: number | null = null) {
  return db
    .insert(schema.comments)
    .values({ userId, lessonId, parentId, body })
    .returning()
    .get();
}

describe("discussion-question", () => {
  it("notifies the course's Instructor of a Student's question", async () => {
    const { sender, calls } = recordingSender();
    const question = addComment(base.user.id, "How do I start?");

    await notifyDiscussionQuestion(db, question.id, sender);

    expect(calls).toEqual([
      [
        "discussion-question",
        {
          actor: { id: String(base.user.id), name: "Test User", avatar: null },
          recipients: [
            { id: String(base.instructor.id), name: "Test Instructor", avatar: null },
          ],
          data: {
            kind: "discussion-question",
            actorName: "Test User",
            actorAvatar: null,
            courseTitle: "Test Course",
            lessonTitle: "Intro Lesson",
            excerpt: "How do I start?",
            url: `/courses/test-course/lessons/${lessonId}`,
          },
        },
        { idempotencyKey: `discussion-question:${question.id}` },
      ],
    ]);
  });

  it("notifies the Instructor of a Platform Admin's question", async () => {
    const { sender, calls } = recordingSender();
    const question = addComment(admin.id, "Admin asks");

    await notifyDiscussionQuestion(db, question.id, sender);

    expect(calls).toHaveLength(1);
    expect(calls[0][1].recipients.map((r) => r.id)).toEqual([
      String(base.instructor.id),
    ]);
  });

  it("sends nothing when the Instructor asks in their own course", async () => {
    const { sender, calls } = recordingSender();
    const question = addComment(base.instructor.id, "Own question");

    await notifyDiscussionQuestion(db, question.id, sender);

    expect(calls).toEqual([]);
  });
});

describe("discussion-reply", () => {
  it("notifies the question's author", async () => {
    const { sender, calls } = recordingSender();
    const question = addComment(base.user.id, "How do I start?");
    const reply = addComment(base.instructor.id, "Read the intro", question.id);

    await notifyDiscussionReply(db, reply.id, sender);

    expect(calls).toEqual([
      [
        "discussion-reply",
        {
          actor: { id: String(base.instructor.id), name: "Test Instructor", avatar: null },
          recipients: [{ id: String(base.user.id), name: "Test User", avatar: null }],
          data: {
            kind: "discussion-reply",
            actorName: "Test Instructor",
            actorAvatar: null,
            courseTitle: "Test Course",
            lessonTitle: "Intro Lesson",
            excerpt: "Read the intro",
            url: `/courses/test-course/lessons/${lessonId}`,
          },
        },
        { idempotencyKey: `discussion-reply:${reply.id}` },
      ],
    ]);
  });

  it("sends nothing when the author replies in their own thread", async () => {
    const { sender, calls } = recordingSender();
    const question = addComment(base.user.id, "Q");
    const reply = addComment(base.user.id, "Follow-up", question.id);

    await notifyDiscussionReply(db, reply.id, sender);

    expect(calls).toEqual([]);
  });
});

describe("notifyComment", () => {
  it("sends a question for a top-level comment and a reply for a child", async () => {
    const { sender, calls } = recordingSender();
    const question = addComment(base.user.id, "Q");
    const reply = addComment(base.instructor.id, "A", question.id);

    await notifyComment(db, question.id, sender);
    await notifyComment(db, reply.id, sender);

    expect(calls.map((c) => c[0])).toEqual([
      "discussion-question",
      "discussion-reply",
    ]);
  });

  it("resolves and logs once when the sender throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("knock down");
    const question = addComment(base.user.id, "Q");

    await expect(
      notifyComment(db, question.id, {
        trigger: () => Promise.reject(boom),
      })
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("discussion-question"),
      expect.stringContaining(`discussion-question:${question.id}`),
      boom
    );
    error.mockRestore();
  });
});
