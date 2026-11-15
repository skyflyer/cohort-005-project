import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  notifyComment,
  notifyDiscussionQuestion,
  notifyDiscussionReply,
  notifyNewEnrollment,
  notifySeatClaimed,
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

// ─── #49: Seats and Enrollments ───

describe("seats and enrollments", () => {
  let teamAdmin: typeof schema.users.$inferSelect;

  beforeEach(() => {
    teamAdmin = db
      .insert(schema.users)
      .values({ name: "Tina Team", email: "tina@example.com", role: UserRole.Student })
      .returning()
      .get();
  });

  function buyTeamLicence(quantity: number) {
    const purchase = db
      .insert(schema.purchases)
      .values({ userId: teamAdmin.id, courseId: base.course.id, amountPaid: 1000 * quantity })
      .returning()
      .get();
    const team = db.insert(schema.teams).values({}).returning().get();
    const seats = Array.from({ length: quantity }, (_, i) =>
      db
        .insert(schema.coupons)
        .values({
          teamId: team.id,
          courseId: base.course.id,
          code: `code-${i}`,
          purchaseId: purchase.id,
        })
        .returning()
        .get()
    );
    return { purchase, seats };
  }

  function claim(seatId: number, userId: number) {
    db.update(schema.coupons)
      .set({ redeemedByUserId: userId, redeemedAt: new Date().toISOString() })
      .where(eq(schema.coupons.id, seatId))
      .run();
    return db
      .insert(schema.enrollments)
      .values({ userId, courseId: base.course.id })
      .returning()
      .get();
  }

  it("seat-claimed notifies the Team Admin with the Seats left", async () => {
    const { sender, calls } = recordingSender();
    const { seats } = buyTeamLicence(3);
    claim(seats[0].id, base.user.id);

    await notifySeatClaimed(db, seats[0].id, sender);

    expect(calls).toEqual([
      [
        "seat-claimed",
        {
          actor: { id: String(base.user.id), name: "Test User", avatar: null },
          recipients: [{ id: String(teamAdmin.id), name: "Tina Team", avatar: null }],
          data: {
            kind: "seat-claimed",
            actorName: "Test User",
            actorAvatar: null,
            courseTitle: "Test Course",
            seatsLeft: 2,
            url: "/team",
          },
        },
        { idempotencyKey: `seat-claimed:${seats[0].id}` },
      ],
    ]);
  });

  it("new-enrollment notifies the course's Instructor", async () => {
    const { sender, calls } = recordingSender();
    const enrollment = db
      .insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .returning()
      .get();

    await notifyNewEnrollment(db, enrollment.id, sender);

    expect(calls).toEqual([
      [
        "new-enrollment",
        {
          actor: { id: String(base.user.id), name: "Test User", avatar: null },
          recipients: [
            { id: String(base.instructor.id), name: "Test Instructor", avatar: null },
          ],
          data: {
            kind: "new-enrollment",
            actorName: "Test User",
            actorAvatar: null,
            courseTitle: "Test Course",
            url: `/instructor/${base.course.id}/students`,
          },
        },
        { idempotencyKey: `new-enrollment:${enrollment.id}` },
      ],
    ]);
  });

  it("a Lapsed Student enrolling again gets a new idempotency key", async () => {
    const { sender, calls } = recordingSender();
    const first = db
      .insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .returning()
      .get();
    db.delete(schema.enrollments).where(eq(schema.enrollments.id, first.id)).run();
    const second = db
      .insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .returning()
      .get();

    await notifyNewEnrollment(db, second.id, sender);

    expect(calls[0][2].idempotencyKey).toBe(`new-enrollment:${second.id}`);
    expect(second.id).not.toBe(first.id);
  });

  it("a Seat claim makes two separate calls", async () => {
    const { sender, calls } = recordingSender();
    const { seats } = buyTeamLicence(1);
    const enrollment = claim(seats[0].id, base.user.id);

    await notifySeatClaimed(db, seats[0].id, sender);
    await notifyNewEnrollment(db, enrollment.id, sender);

    expect(calls.map((c) => c[0])).toEqual(["seat-claimed", "new-enrollment"]);
  });

  it("a Team Licence purchase sends no new-enrollment", async () => {
    const { sender, calls } = recordingSender();
    buyTeamLicence(2);

    // Nothing enrolls: there is no Enrollment to notify about.
    await notifyNewEnrollment(db, 9999, sender);

    expect(calls).toEqual([]);
  });

  it("new-enrollment still goes out when seat-claimed throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls } = recordingSender();
    const sender: NotificationSender = {
      async trigger(...args) {
        if (args[0] === "seat-claimed") throw new Error("knock down");
        calls.push(args);
      },
    };
    const { seats } = buyTeamLicence(1);
    const enrollment = claim(seats[0].id, base.user.id);

    await notifySeatClaimed(db, seats[0].id, sender);
    await notifyNewEnrollment(db, enrollment.id, sender);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("seat-claimed"),
      expect.stringContaining(`seat-claimed:${seats[0].id}`),
      expect.any(Error)
    );
    expect(calls.map((c) => c[0])).toEqual(["new-enrollment"]);
    error.mockRestore();
  });
});
