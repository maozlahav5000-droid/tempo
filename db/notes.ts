import { env } from "cloudflare:workers";
import type { TempoAccessMode } from "./schema";

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

const NOTES_TABLES = {
  owner: {
    notes: "lesson_notes",
    sortIndex: "lesson_notes_sort_idx",
  },
  guest: {
    notes: "guest_lesson_notes",
    sortIndex: "guest_lesson_notes_sort_idx",
  },
} as const;

const schemaReady: Partial<Record<TempoAccessMode, Promise<void>>> = {};

function getTableNames(mode: TempoAccessMode) {
  return NOTES_TABLES[mode];
}

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

async function initializeNotesSchema(mode: TempoAccessMode) {
  const db = getDatabase();
  const tables = getTableNames(mode);
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ${tables.notes} (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        lesson_date TEXT NOT NULL DEFAULT '',
        body_html TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS ${tables.sortIndex} ON ${tables.notes}(lesson_date, updated_at)`,
    ),
    db.prepare("PRAGMA optimize"),
  ]);
}

export function ensureNotesSchema(mode: TempoAccessMode = "owner") {
  if (!schemaReady[mode]) {
    schemaReady[mode] = initializeNotesSchema(mode).catch((error) => {
      delete schemaReady[mode];
      throw error;
    });
  }
  return schemaReady[mode];
}

export async function listLessonNotes(mode: TempoAccessMode = "owner") {
  await ensureNotesSchema(mode);
  const { notes } = getTableNames(mode);
  const result = await getDatabase()
    .prepare(`
      SELECT id, title, lesson_date, body_html, created_at, updated_at
      FROM ${notes}
      ORDER BY
        CASE WHEN lesson_date = '' THEN 1 ELSE 0 END,
        lesson_date ASC,
        created_at ASC,
        id ASC
    `)
    .all<LessonNoteRow>();
  return result.results.map(mapLessonNote);
}

export async function getLessonNote(id: string, mode: TempoAccessMode = "owner") {
  await ensureNotesSchema(mode);
  const { notes } = getTableNames(mode);
  const row = await getDatabase()
    .prepare(`
      SELECT id, title, lesson_date, body_html, created_at, updated_at
      FROM ${notes}
      WHERE id = ?
    `)
    .bind(id)
    .first<LessonNoteRow>();
  return row ? mapLessonNote(row) : null;
}

export async function createLessonNote(note: LessonNoteRecord, mode: TempoAccessMode = "owner") {
  await ensureNotesSchema(mode);
  const { notes } = getTableNames(mode);
  await getDatabase()
    .prepare(`
      INSERT INTO ${notes} (id, title, lesson_date, body_html, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(note.id, note.title, note.lessonDate, note.bodyHtml, note.createdAt, note.updatedAt)
    .run();
  return note;
}

export async function importLegacyLessonNoteIfEmpty(
  note: LessonNoteRecord,
  mode: TempoAccessMode = "owner",
) {
  await ensureNotesSchema(mode);
  const { notes } = getTableNames(mode);
  const result = await getDatabase()
    .prepare(`
      INSERT INTO ${notes} (id, title, lesson_date, body_html, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM ${notes} LIMIT 1)
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
  mode: TempoAccessMode = "owner",
) {
  await ensureNotesSchema(mode);
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
  if (!assignments.length) return getLessonNote(id, mode);

  const updatedAt = new Date().toISOString();
  assignments.push("updated_at = ?");
  values.push(updatedAt, id);
  const { notes } = getTableNames(mode);
  const result = await getDatabase()
    .prepare(`UPDATE ${notes} SET ${assignments.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return result.meta.changes ? getLessonNote(id, mode) : null;
}

export async function deleteLessonNote(id: string, mode: TempoAccessMode = "owner") {
  await ensureNotesSchema(mode);
  const { notes } = getTableNames(mode);
  const result = await getDatabase().prepare(`DELETE FROM ${notes} WHERE id = ?`).bind(id).run();
  return Boolean(result.meta.changes);
}
