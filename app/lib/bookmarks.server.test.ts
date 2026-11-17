import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  isBookmarked,
  listBookmarks,
  toggleBookmark,
} from "./bookmarks.server";

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

describe("toggling a Bookmark", () => {
  it("bookmarks a Lesson with no Bookmark, and un-bookmarks it on the next toggle", () => {
    expect(isBookmarked(db, base.user.id, firstLessonId)).toBe(false);

    expect(toggleBookmark(db, base.user.id, firstLessonId, NOW)).toBe(true);
    expect(isBookmarked(db, base.user.id, firstLessonId)).toBe(true);

    expect(toggleBookmark(db, base.user.id, firstLessonId, LATER)).toBe(false);
    expect(isBookmarked(db, base.user.id, firstLessonId)).toBe(false);
  });

  it("never leaves a Student with two Bookmarks on one Lesson", () => {
    toggleBookmark(db, base.user.id, firstLessonId, NOW);

    expect(() =>
      db
        .insert(schema.bookmarks)
        .values({ userId: base.user.id, lessonId: firstLessonId })
        .run()
    ).toThrow(/UNIQUE/);
    expect(listBookmarks(db, base.user.id)).toHaveLength(1);
  });
});

describe("listing Bookmarks", () => {
  it("lists only the Student's own Bookmarks, newest first, with Lesson and Course", () => {
    toggleBookmark(db, base.user.id, firstLessonId, NOW);
    toggleBookmark(db, base.user.id, secondLessonId, LATER);
    toggleBookmark(db, base.instructor.id, firstLessonId, LATER);

    expect(listBookmarks(db, base.user.id)).toEqual([
      expect.objectContaining({
        lessonId: secondLessonId,
        lessonTitle: "Lesson 2",
        courseTitle: base.course.title,
        courseSlug: base.course.slug,
        createdAt: LATER.toISOString(),
      }),
      expect.objectContaining({
        lessonId: firstLessonId,
        lessonTitle: "Lesson 1",
        createdAt: NOW.toISOString(),
      }),
    ]);
  });
});
