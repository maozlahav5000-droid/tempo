import { env } from "cloudflare:workers";

export type LibrarySection = "warmup" | "practice";

export type LibraryFolderRecord = {
  id: string;
  name: string;
  section: LibrarySection;
  createdAt: string;
  updatedAt: string;
};

export type LibraryFileRecord = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  section: LibrarySection;
  folderId: string | null;
  storageKey: string;
  createdAt: string;
};

type FolderRow = {
  id: string;
  name: string;
  section: LibrarySection;
  created_at: string;
  updated_at: string;
};

type LibraryRow = {
  id: string;
  name: string;
  content_type: string;
  size: number;
  section: LibrarySection;
  folder_id: string | null;
  storage_key: string;
  created_at: string;
};

type LibraryBindings = {
  DB?: D1Database;
  FILES?: KVNamespace;
};

let schemaReady: Promise<void> | null = null;

function getBindings() {
  const bindings = env as unknown as LibraryBindings;
  if (!bindings.DB || !bindings.FILES) {
    throw new Error("מאגר הקבצים אינו זמין כרגע.");
  }
  return { db: bindings.DB, storage: bindings.FILES };
}

function mapFolderRow(row: FolderRow): LibraryFolderRecord {
  return {
    id: row.id,
    name: row.name,
    section: row.section,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFileRow(row: LibraryRow): LibraryFileRecord {
  return {
    id: row.id,
    name: row.name,
    contentType: row.content_type,
    size: Number(row.size),
    section: row.section,
    folderId: row.folder_id,
    storageKey: row.storage_key,
    createdAt: row.created_at,
  };
}

export function getLibraryStorage() {
  return getBindings().storage;
}

async function initializeLibrarySchema() {
  const { db } = getBindings();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS practice_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        section TEXT NOT NULL CHECK (section IN ('warmup', 'practice')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS practice_files (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        section TEXT NOT NULL CHECK (section IN ('warmup', 'practice')),
        folder_id TEXT,
        storage_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare("CREATE INDEX IF NOT EXISTS practice_folders_section_idx ON practice_folders(section)"),
    db.prepare("CREATE INDEX IF NOT EXISTS practice_files_section_idx ON practice_files(section)"),
  ]);

  const columns = await db.prepare("PRAGMA table_info(practice_files)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "folder_id")) {
    await db.prepare("ALTER TABLE practice_files ADD COLUMN folder_id TEXT").run();
  }

  await db.batch([
    db.prepare("CREATE INDEX IF NOT EXISTS practice_files_folder_idx ON practice_files(folder_id)"),
    db.prepare("PRAGMA optimize"),
  ]);
}

export function ensureLibrarySchema() {
  if (!schemaReady) {
    schemaReady = initializeLibrarySchema().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

export async function listLibraryFolders() {
  await ensureLibrarySchema();
  const { db } = getBindings();
  const result = await db
    .prepare(`
      SELECT id, name, section, created_at, updated_at
      FROM practice_folders
      ORDER BY name COLLATE NOCASE ASC, created_at ASC
    `)
    .all<FolderRow>();
  return result.results.map(mapFolderRow);
}

export async function getLibraryFolder(id: string) {
  await ensureLibrarySchema();
  const { db } = getBindings();
  const row = await db
    .prepare(`
      SELECT id, name, section, created_at, updated_at
      FROM practice_folders
      WHERE id = ?
    `)
    .bind(id)
    .first<FolderRow>();
  return row ? mapFolderRow(row) : null;
}

async function folderNameExists(name: string, section: LibrarySection, exceptId?: string) {
  const { db } = getBindings();
  const row = await db
    .prepare(`
      SELECT id
      FROM practice_folders
      WHERE section = ? AND lower(name) = lower(?) AND (? IS NULL OR id != ?)
      LIMIT 1
    `)
    .bind(section, name, exceptId ?? null, exceptId ?? null)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function createLibraryFolder(folder: LibraryFolderRecord) {
  await ensureLibrarySchema();
  if (await folderNameExists(folder.name, folder.section)) {
    throw new Error("כבר קיימת תיקייה בשם הזה.");
  }

  const { db } = getBindings();
  await db
    .prepare(`
      INSERT INTO practice_folders (id, name, section, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(folder.id, folder.name, folder.section, folder.createdAt, folder.updatedAt)
    .run();
  return folder;
}

export async function updateLibraryFolder(
  id: string,
  changes: { name?: string; section?: LibrarySection },
) {
  const current = await getLibraryFolder(id);
  if (!current) return null;

  const nextName = changes.name ?? current.name;
  const nextSection = changes.section ?? current.section;
  if (await folderNameExists(nextName, nextSection, id)) {
    throw new Error("כבר קיימת תיקייה בשם הזה.");
  }

  const updatedAt = new Date().toISOString();
  const { db } = getBindings();
  await db.batch([
    db
      .prepare("UPDATE practice_folders SET name = ?, section = ?, updated_at = ? WHERE id = ?")
      .bind(nextName, nextSection, updatedAt, id),
    db.prepare("UPDATE practice_files SET section = ? WHERE folder_id = ?").bind(nextSection, id),
  ]);
  return getLibraryFolder(id);
}

export async function deleteLibraryFolder(id: string) {
  const current = await getLibraryFolder(id);
  if (!current) return false;

  const { db } = getBindings();
  await db.batch([
    db.prepare("UPDATE practice_files SET folder_id = NULL WHERE folder_id = ?").bind(id),
    db.prepare("DELETE FROM practice_folders WHERE id = ?").bind(id),
  ]);
  return true;
}

export async function listLibraryFiles() {
  await ensureLibrarySchema();
  const { db } = getBindings();
  const result = await db
    .prepare(`
      SELECT id, name, content_type, size, section, folder_id, storage_key, created_at
      FROM practice_files
      ORDER BY created_at DESC, name COLLATE NOCASE ASC
    `)
    .all<LibraryRow>();
  return result.results.map(mapFileRow);
}

export async function getLibraryFile(id: string) {
  await ensureLibrarySchema();
  const { db } = getBindings();
  const row = await db
    .prepare(`
      SELECT id, name, content_type, size, section, folder_id, storage_key, created_at
      FROM practice_files
      WHERE id = ?
    `)
    .bind(id)
    .first<LibraryRow>();
  return row ? mapFileRow(row) : null;
}

export async function addLibraryFile(file: LibraryFileRecord) {
  await ensureLibrarySchema();
  const { db } = getBindings();
  await db
    .prepare(`
      INSERT INTO practice_files
        (id, name, content_type, size, section, folder_id, storage_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      file.id,
      file.name,
      file.contentType,
      file.size,
      file.section,
      file.folderId,
      file.storageKey,
      file.createdAt,
    )
    .run();
  return file;
}

export async function updateLibraryFile(
  id: string,
  changes: { name?: string; section?: LibrarySection; folderId?: string | null },
) {
  const current = await getLibraryFile(id);
  if (!current) return null;

  const nextName = changes.name ?? current.name;
  let nextSection = changes.section ?? current.section;
  let nextFolderId = changes.folderId === undefined ? current.folderId : changes.folderId;

  if (nextFolderId) {
    const folder = await getLibraryFolder(nextFolderId);
    if (!folder) throw new Error("התיקייה שנבחרה לא נמצאה.");
    nextSection = folder.section;
  } else if (changes.section && changes.section !== current.section) {
    nextFolderId = null;
  }

  const { db } = getBindings();
  await db
    .prepare("UPDATE practice_files SET name = ?, section = ?, folder_id = ? WHERE id = ?")
    .bind(nextName, nextSection, nextFolderId, id)
    .run();
  return getLibraryFile(id);
}

export async function deleteLibraryFile(id: string) {
  const file = await getLibraryFile(id);
  if (!file) return false;

  const { db, storage } = getBindings();
  await storage.delete(file.storageKey);
  await db.prepare("DELETE FROM practice_files WHERE id = ?").bind(id).run();
  return true;
}
