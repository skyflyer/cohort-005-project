import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { courses, lessons, modules, notes } from "~/db/schema";
import type { Db } from "~/lib/comments.server";

// ─── Notes ───
// A Student's own plain-text writing about a Lesson, private to that Student.
// One per Student per Lesson, enforced by the `notes_user_lesson_unique`
// index. See GLOSSARY.md.
//
// Nothing outside the owning Student's Lesson page and Saved page may read a
// Note body: no Instructor or Platform Admin view.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Callers check content access before calling in.

export const MAX_NOTE_LENGTH = 2000;

/** A Note body: trimmed plain text, refused (never truncated) past the cap. */
export const noteBodySchema = z
  .string()
  .trim()
  .max(
    MAX_NOTE_LENGTH,
    `A note can be at most ${MAX_NOTE_LENGTH.toLocaleString("en")} characters.`
  );

type Note = typeof notes.$inferSelect;

export type SaveNoteResult =
  | { ok: true; note: Note | null }
  | { ok: false; error: string };

/** The Student's Note on a Lesson, if they have one. */
export function getNote(db: Db, userId: number, lessonId: number) {
  return db
    .select({ body: notes.body, updatedAt: notes.updatedAt })
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
    .get();
}

/**
 * Creates the Student's Note on a Lesson, or replaces its body and moves
 * `updatedAt` on. An empty body removes the Note, so the Student can clear it.
 */
export function saveNote(
  db: Db,
  userId: number,
  lessonId: number,
  body: string,
  now: Date
): SaveNoteResult {
  const parsed = noteBodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }

  if (parsed.data.length === 0) {
    db.delete(notes)
      .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
      .run();
    return { ok: true, note: null };
  }

  const timestamp = now.toISOString();
  const note = db
    .insert(notes)
    .values({
      userId,
      lessonId,
      body: parsed.data,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: [notes.userId, notes.lessonId],
      set: { body: parsed.data, updatedAt: timestamp },
    })
    .returning()
    .get();

  return { ok: true, note };
}

/** The Student's Notes, last edited first, each with its Lesson and Course. */
export function listNotes(db: Db, userId: number) {
  return db
    .select({
      id: notes.id,
      body: notes.body,
      updatedAt: notes.updatedAt,
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(notes)
    .innerJoin(lessons, eq(lessons.id, notes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .all();
}
