import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const practiceFolders = sqliteTable(
  "practice_folders",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    section: text("section", { enum: ["warmup", "practice"] }).notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("practice_folders_section_idx").on(table.section)],
);

export const practiceFiles = sqliteTable(
  "practice_files",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    section: text("section", { enum: ["warmup", "practice"] }).notNull(),
    folderId: text("folder_id"),
    storageKey: text("storage_key").notNull().unique(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("practice_files_section_idx").on(table.section),
    index("practice_files_folder_idx").on(table.folderId),
  ],
);

export const lessonNotes = sqliteTable(
  "lesson_notes",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    lessonDate: text("lesson_date").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("lesson_notes_sort_idx").on(table.lessonDate, table.updatedAt)],
);
