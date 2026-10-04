import { env } from "cloudflare:workers";

export type LessonNoteRecord = {
  id: string;
  title: string;
  lessonDate: string;
  bodyHtml: string;
  createdAt: string;
  updatedAt: string;
};

type LessonNoteRow = {
  id: string;
  title: string;
  lesson_date: string;
  body_html: string;
  created_at: string;
  updated_at: string;
};

type NotesBindings = {
  DB?: D1Database;
};

let schemaReady: Promise<void> | null = null;

function getDatabase() {
  const bindings = env as unknown as NotesBindings;
  if (!bindings.DB) throw new Error("מאגר ההערות אינו זמין כרגע.");
  return bindings.DB;
}

function mapLessonNote(row: LessonNoteRow): LessonNoteRecord {
  return {
    id: row.id,
    title: row.title,
    lessonDate: row.lesson_date,
    bodyHtml: row.body_html,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function initializeNotesSchema() {
  const db = getDatabase();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS lesson_notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        lesson_date TEXT NOT NULL DEFAULT '',
        body_html TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare("CREATE INDEX IF NOT EXISTS lesson_notes_sort_idx ON lesson_notes(lesson_date, updated_at)"),
    db.prepare("PRAGMA optimize"),
  ]);
}

export function ensureNotesSchema() {
  if (!schemaReady) {
    schemaReady = initializeNotesSchema().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

export async function listLessonNotes() {
  await ensureNotesSchema();
  const result = await getDatabase()
    .prepare(`
      SELECT id, title, lesson_date, body_html, created_at, updated_at
      FROM lesson_notes
      ORDER BY
        CASE WHEN lesson_date = '' THEN 1 ELSE 0 END,
        lesson_date ASC,
        created_at ASC,
        id ASC
    `)
    .all<LessonNoteRow>();
  return result.results.map(mapLessonNote);
}

export async function getLessonNote(id: string) {
  await ensureNotesSchema();
  const row = await getDatabase()
    .prepare(`
      SELECT id, title, lesson_date, body_html, created_at, updated_at
      FROM lesson_notes
      WHERE id = ?
    `)
    .bind(id)
    .first<LessonNoteRow>();
  return row ? mapLessonNote(row) : null;
}

export async function createLessonNote(note: LessonNoteRecord) {
  await ensureNotesSchema();
  await getDatabase()
    .prepare(`
      INSERT INTO lesson_notes (id, title, lesson_date, body_html, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(note.id, note.title, note.lessonDate, note.bodyHtml, note.createdAt, note.updatedAt)
    .run();
  return note;
}

export async function importLegacyLessonNoteIfEmpty(note: LessonNoteRecord) {
  await ensureNotesSchema();
  const result = await getDatabase()
    .prepare(`
      INSERT INTO lesson_notes (id, title, lesson_date, body_html, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM lesson_notes LIMIT 1)
    `)
    .bind(note.id, note.title, note.lessonDate, note.bodyHtml, note.createdAt, note.updatedAt)
    .run();
  return {
    imported: Boolean(result.meta.changes),
    note: result.meta.changes ? note : null,
  };
}

export async function updateLessonNote(
  id: string,
  changes: Partial<Pick<LessonNoteRecord, "title" | "lessonDate" | "bodyHtml">>,
) {
  await ensureNotesSchema();
  const assignments: string[] = [];
  const values: string[] = [];
  if (changes.title !== undefined) {
    assignments.push("title = ?");
    values.push(changes.title);
  }
  if (changes.lessonDate !== undefined) {
    assignments.push("lesson_date = ?");
    values.push(changes.lessonDate);
  }
  if (changes.bodyHtml !== undefined) {
    assignments.push("body_html = ?");
    values.push(changes.bodyHtml);
  }
  if (!assignments.length) return getLessonNote(id);

  const updatedAt = new Date().toISOString();
  assignments.push("updated_at = ?");
  values.push(updatedAt, id);
  const result = await getDatabase()
    .prepare(`UPDATE lesson_notes SET ${assignments.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return result.meta.changes ? getLessonNote(id) : null;
}

export async function deleteLessonNote(id: string) {
  await ensureNotesSchema();
  const result = await getDatabase().prepare("DELETE FROM lesson_notes WHERE id = ?").bind(id).run();
  return Boolean(result.meta.changes);
}
