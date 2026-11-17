import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { getNote, listNotes, saveNote } from "./notes.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);
const LATER = new Date(2026, 9, 7, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let firstLessonId: number;
let secondLessonId: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  [firstLessonId, secondLessonId] = [1, 2].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

describe("saving a Note", () => {
  it("creates a Note with the body trimmed", () => {
    expect(
      saveNote(db, base.user.id, firstLessonId, "  # not a heading  ", NOW)
    ).toMatchObject({ ok: true });

    expect(getNote(db, base.user.id, firstLessonId)).toEqual({
      body: "# not a heading",
      updatedAt: NOW.toISOString(),
    });
  });

  it("replaces the body and moves the last-edited time on, keeping one Note", () => {
    saveNote(db, base.user.id, firstLessonId, "First thoughts", NOW);

    const result = saveNote(
      db,
      base.user.id,
      firstLessonId,
      "Second thoughts",
      LATER
    );

    expect(result).toMatchObject({
      ok: true,
      note: {
        body: "Second thoughts",
        createdAt: NOW.toISOString(),
        updatedAt: LATER.toISOString(),
      },
    });
    expect(listNotes(db, base.user.id)).toHaveLength(1);
  });

  it("accepts a Note of exactly 2,000 characters", () => {
    expect(
      saveNote(db, base.user.id, firstLessonId, "a".repeat(2000), NOW)
    ).toMatchObject({ ok: true });
    expect(getNote(db, base.user.id, firstLessonId)?.body).toHaveLength(2000);
  });

  it("refuses a Note over 2,000 characters and stores nothing", () => {
    expect(
      saveNote(db, base.user.id, firstLessonId, "a".repeat(2001), NOW)
    ).toEqual({ ok: false, error: "A note can be at most 2,000 characters." });
    expect(getNote(db, base.user.id, firstLessonId)).toBeUndefined();
  });

  it("removes the Note when saved empty", () => {
    saveNote(db, base.user.id, firstLessonId, "Something", NOW);

    expect(saveNote(db, base.user.id, firstLessonId, "   ", LATER)).toEqual({
      ok: true,
      note: null,
    });
    expect(getNote(db, base.user.id, firstLessonId)).toBeUndefined();
  });

  it("never leaves a Student with two Notes on one Lesson", () => {
    saveNote(db, base.user.id, firstLessonId, "Mine", NOW);

    expect(() =>
      db
        .insert(schema.notes)
        .values({ userId: base.user.id, lessonId: firstLessonId, body: "Dup" })
        .run()
    ).toThrow(/UNIQUE/);
  });
});

describe("listing Notes", () => {
  it("lists only the Student's own Notes, last edited first, with Lesson and Course", () => {
    saveNote(db, base.user.id, firstLessonId, "On lesson 1", NOW);
    saveNote(db, base.user.id, secondLessonId, "On lesson 2", NOW);
    saveNote(db, base.user.id, firstLessonId, "Lesson 1, edited", LATER);
    saveNote(db, base.instructor.id, secondLessonId, "Not theirs", LATER);

    expect(listNotes(db, base.user.id)).toEqual([
      expect.objectContaining({
        body: "Lesson 1, edited",
        lessonId: firstLessonId,
        lessonTitle: "Lesson 1",
        courseTitle: base.course.title,
        courseSlug: base.course.slug,
        updatedAt: LATER.toISOString(),
      }),
      expect.objectContaining({
        body: "On lesson 2",
        lessonId: secondLessonId,
        updatedAt: NOW.toISOString(),
      }),
    ]);
  });
});
