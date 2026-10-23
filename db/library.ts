import { env } from "cloudflare:workers";
import type { TempoAccessMode } from "./schema";

export const LIBRARY_SECTIONS = ["warmup", "practice", "personal"] as const;
export type LibrarySection = (typeof LIBRARY_SECTIONS)[number];

export function isLibrarySection(value: unknown): value is LibrarySection {
  return typeof value === "string" && LIBRARY_SECTIONS.includes(value as LibrarySection);
}

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

const LIBRARY_TABLES = {
  owner: {
    folders: "practice_folders",
    files: "practice_files",
    folderSectionIndex: "practice_folders_section_idx",
    fileSectionIndex: "practice_files_section_idx",
    fileFolderIndex: "practice_files_folder_idx",
  },
  guest: {
    folders: "guest_practice_folders",
    files: "guest_practice_files",
    folderSectionIndex: "guest_practice_folders_section_idx",
    fileSectionIndex: "guest_practice_files_section_idx",
    fileFolderIndex: "guest_practice_files_folder_idx",
  },
} as const;

const schemaReady: Partial<Record<TempoAccessMode, Promise<void>>> = {};

function getTableNames(mode: TempoAccessMode) {
  return LIBRARY_TABLES[mode];
}

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

export function getLibraryStorageKey(id: string, mode: TempoAccessMode = "owner") {
  return mode === "guest" ? `guest/practice-library/${id}` : `practice-library/${id}`;
}

async function initializeLibrarySchema(mode: TempoAccessMode) {
  const { db } = getBindings();
  const tables = getTableNames(mode);
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ${tables.folders} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        section TEXT NOT NULL CHECK (section IN ('warmup', 'practice', 'personal')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ${tables.files} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        section TEXT NOT NULL CHECK (section IN ('warmup', 'practice', 'personal')),
        folder_id TEXT,
        storage_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
  ]);

  const columns = await db.prepare(`PRAGMA table_info(${tables.files})`).all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "folder_id")) {
    await db.prepare(`ALTER TABLE ${tables.files} ADD COLUMN folder_id TEXT`).run();
  }

  await migrateLegacySectionConstraints(db, mode);

  await db.batch([
    db.prepare(
      `CREATE INDEX IF NOT EXISTS ${tables.folderSectionIndex} ON ${tables.folders}(section)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS ${tables.fileSectionIndex} ON ${tables.files}(section)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS ${tables.fileFolderIndex} ON ${tables.files}(folder_id)`,
    ),
    db.prepare("PRAGMA optimize"),
  ]);
}

function needsSectionConstraintMigration(sql: string | null | undefined) {
  return Boolean(sql && /\bCHECK\s*\(/i.test(sql) && !/['"]personal['"]/i.test(sql));
}

async function migrateLegacySectionConstraints(db: D1Database, mode: TempoAccessMode) {
  const tables = getTableNames(mode);
  const folderUpgradeTable = `${tables.folders}_section_upgrade`;
  const fileUpgradeTable = `${tables.files}_section_upgrade`;
  const [folderSchema, fileSchema] = await Promise.all([
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind(tables.folders)
      .first<{ sql: string | null }>(),
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind(tables.files)
      .first<{ sql: string | null }>(),
  ]);

  if (needsSectionConstraintMigration(folderSchema?.sql)) {
    await db.batch([
      db.prepare(`DROP TABLE IF EXISTS ${folderUpgradeTable}`),
      db.prepare(`
        CREATE TABLE ${folderUpgradeTable} (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          section TEXT NOT NULL CHECK (section IN ('warmup', 'practice', 'personal')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `),
      db.prepare(`
        INSERT INTO ${folderUpgradeTable} (id, name, section, created_at, updated_at)
        SELECT id, name, section, created_at, updated_at FROM ${tables.folders}
      `),
      db.prepare(`DROP TABLE ${tables.folders}`),
      db.prepare(`ALTER TABLE ${folderUpgradeTable} RENAME TO ${tables.folders}`),
    ]);
  }

  if (needsSectionConstraintMigration(fileSchema?.sql)) {
    await db.batch([
      db.prepare(`DROP TABLE IF EXISTS ${fileUpgradeTable}`),
      db.prepare(`
        CREATE TABLE ${fileUpgradeTable} (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          section TEXT NOT NULL CHECK (section IN ('warmup', 'practice', 'personal')),
          folder_id TEXT,
          storage_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `),
      db.prepare(`
        INSERT INTO ${fileUpgradeTable}
          (id, name, content_type, size, section, folder_id, storage_key, created_at)
        SELECT id, name, content_type, size, section, folder_id, storage_key, created_at
        FROM ${tables.files}
      `),
      db.prepare(`DROP TABLE ${tables.files}`),
      db.prepare(`ALTER TABLE ${fileUpgradeTable} RENAME TO ${tables.files}`),
    ]);
  }
}

export function ensureLibrarySchema(mode: TempoAccessMode = "owner") {
  if (!schemaReady[mode]) {
    schemaReady[mode] = initializeLibrarySchema(mode).catch((error) => {
      delete schemaReady[mode];
      throw error;
    });
  }
  return schemaReady[mode];
}

export async function listLibraryFolders(mode: TempoAccessMode = "owner") {
  await ensureLibrarySchema(mode);
  const { db } = getBindings();
  const { folders } = getTableNames(mode);
  const result = await db
    .prepare(`
      SELECT id, name, section, created_at, updated_at
      FROM ${folders}
      ORDER BY name COLLATE NOCASE ASC, created_at ASC
    `)
    .all<FolderRow>();
  return result.results.map(mapFolderRow);
}

export async function getLibraryFolder(id: string, mode: TempoAccessMode = "owner") {
  await ensureLibrarySchema(mode);
  const { db } = getBindings();
  const { folders } = getTableNames(mode);
  const row = await db
    .prepare(`
      SELECT id, name, section, created_at, updated_at
      FROM ${folders}
      WHERE id = ?
    `)
    .bind(id)
    .first<FolderRow>();
  return row ? mapFolderRow(row) : null;
}

async function folderNameExists(
  name: string,
  section: LibrarySection,
  exceptId: string | undefined,
  mode: TempoAccessMode,
) {
  const { db } = getBindings();
  const { folders } = getTableNames(mode);
  const row = await db
    .prepare(`
      SELECT id
      FROM ${folders}
      WHERE section = ? AND lower(name) = lower(?) AND (? IS NULL OR id != ?)
      LIMIT 1
    `)
    .bind(section, name, exceptId ?? null, exceptId ?? null)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function createLibraryFolder(
  folder: LibraryFolderRecord,
  mode: TempoAccessMode = "owner",
) {
  await ensureLibrarySchema(mode);
  if (await folderNameExists(folder.name, folder.section, undefined, mode)) {
    throw new Error("כבר קיימת תיקייה בשם הזה.");
  }

  const { db } = getBindings();
  const { folders } = getTableNames(mode);
  await db
    .prepare(`
      INSERT INTO ${folders} (id, name, section, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(folder.id, folder.name, folder.section, folder.createdAt, folder.updatedAt)
    .run();
  return folder;
}

export async function updateLibraryFolder(
  id: string,
  changes: { name?: string; section?: LibrarySection },
  mode: TempoAccessMode = "owner",
) {
  const current = await getLibraryFolder(id, mode);
  if (!current) return null;

  const nextName = changes.name ?? current.name;
  const nextSection = changes.section ?? current.section;
  if (await folderNameExists(nextName, nextSection, id, mode)) {
    throw new Error("כבר קיימת תיקייה בשם הזה.");
  }

  const updatedAt = new Date().toISOString();
  const { db } = getBindings();
  const { folders, files } = getTableNames(mode);
  await db.batch([
    db
      .prepare(`UPDATE ${folders} SET name = ?, section = ?, updated_at = ? WHERE id = ?`)
      .bind(nextName, nextSection, updatedAt, id),
    db.prepare(`UPDATE ${files} SET section = ? WHERE folder_id = ?`).bind(nextSection, id),
  ]);
  return getLibraryFolder(id, mode);
}

export async function deleteLibraryFolder(id: string, mode: TempoAccessMode = "owner") {
  const current = await getLibraryFolder(id, mode);
  if (!current) return false;

  const { db } = getBindings();
  const { folders, files } = getTableNames(mode);
  await db.batch([
    db.prepare(`UPDATE ${files} SET folder_id = NULL WHERE folder_id = ?`).bind(id),
    db.prepare(`DELETE FROM ${folders} WHERE id = ?`).bind(id),
  ]);
  return true;
}

export async function listLibraryFiles(mode: TempoAccessMode = "owner") {
  await ensureLibrarySchema(mode);
  const { db } = getBindings();
  const { files } = getTableNames(mode);
  const result = await db
    .prepare(`
      SELECT id, name, content_type, size, section, folder_id, storage_key, created_at
      FROM ${files}
      ORDER BY created_at DESC, name COLLATE NOCASE ASC
    `)
    .all<LibraryRow>();
  return result.results.map(mapFileRow);
}

export async function getLibraryFile(id: string, mode: TempoAccessMode = "owner") {
  await ensureLibrarySchema(mode);
  const { db } = getBindings();
  const { files } = getTableNames(mode);
  const row = await db
    .prepare(`
      SELECT id, name, content_type, size, section, folder_id, storage_key, created_at
      FROM ${files}
      WHERE id = ?
    `)
    .bind(id)
    .first<LibraryRow>();
  return row ? mapFileRow(row) : null;
}

export async function addLibraryFile(file: LibraryFileRecord, mode: TempoAccessMode = "owner") {
  await ensureLibrarySchema(mode);
  const { db } = getBindings();
  const { files } = getTableNames(mode);
  await db
    .prepare(`
      INSERT INTO ${files}
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
  mode: TempoAccessMode = "owner",
) {
  const current = await getLibraryFile(id, mode);
  if (!current) return null;

  const nextName = changes.name ?? current.name;
  let nextSection = changes.section ?? current.section;
  let nextFolderId = changes.folderId === undefined ? current.folderId : changes.folderId;

  if (nextFolderId) {
    const folder = await getLibraryFolder(nextFolderId, mode);
    if (!folder) throw new Error("התיקייה שנבחרה לא נמצאה.");
    nextSection = folder.section;
  } else if (changes.section && changes.section !== current.section) {
    nextFolderId = null;
  }

  const { db } = getBindings();
  const { files } = getTableNames(mode);
  await db
    .prepare(`UPDATE ${files} SET name = ?, section = ?, folder_id = ? WHERE id = ?`)
    .bind(nextName, nextSection, nextFolderId, id)
    .run();
  return getLibraryFile(id, mode);
}

export async function deleteLibraryFile(id: string, mode: TempoAccessMode = "owner") {
  const file = await getLibraryFile(id, mode);
  if (!file) return false;

  const { db, storage } = getBindings();
  const { files } = getTableNames(mode);
  await storage.delete(file.storageKey);
  await db.prepare(`DELETE FROM ${files} WHERE id = ?`).bind(id).run();
  return true;
}
