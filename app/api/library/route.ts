import {
  addLibraryFile,
  deleteLibraryFile,
  getLibraryStorage,
  getLibraryFile,
  getLibraryFolder,
  listLibraryFiles,
  listLibraryFolders,
  updateLibraryFile,
  type LibrarySection,
} from "../../../db/library";

// Workers KV limits a single value to 25 MiB. Keep headroom for platform
// validation and fail before attempting a write that KV cannot accept.
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function isLibrarySection(value: unknown): value is LibrarySection {
  return value === "warmup" || value === "practice";
}

function normalizedContentType(file: File) {
  if (ALLOWED_CONTENT_TYPES.has(file.type)) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  return null;
}

function publicFile(file: Awaited<ReturnType<typeof getLibraryFile>>) {
  if (!file) return null;
  const { storageKey, ...metadata } = file;
  void storageKey;
  return { ...metadata, url: `/api/library?file=${encodeURIComponent(file.id)}` };
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "לא ניתן להשלים את הפעולה.";
  return Response.json({ error: message }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const fileId = url.searchParams.get("file");

    if (fileId) {
      const record = await getLibraryFile(fileId);
      if (!record) return Response.json({ error: "הקובץ לא נמצא." }, { status: 404 });

      const body = await getLibraryStorage().get(record.storageKey, { type: "stream" });
      if (!body) return Response.json({ error: "תוכן הקובץ לא נמצא." }, { status: 404 });

      const headers = new Headers();
      headers.set("Content-Type", record.contentType);
      headers.set("Content-Length", String(record.size));
      headers.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(record.name)}`);
      headers.set("Cache-Control", "private, no-store");
      return new Response(body, { headers });
    }

    const [files, folders] = await Promise.all([listLibraryFiles(), listLibraryFolders()]);
    return Response.json({ files: files.map((file) => publicFile(file)), folders });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const upload = formData.get("file");
    let section = formData.get("section");
    const requestedFolderId = formData.get("folderId");
    const folderId = typeof requestedFolderId === "string" && requestedFolderId ? requestedFolderId : null;

    if (!(upload instanceof File) || !isLibrarySection(section)) {
      return Response.json({ error: "יש לבחור קובץ וקטגוריה." }, { status: 400 });
    }

    if (folderId) {
      const folder = await getLibraryFolder(folderId);
      if (!folder) return Response.json({ error: "התיקייה שנבחרה לא נמצאה." }, { status: 400 });
      section = folder.section;
    }

    const contentType = normalizedContentType(upload);
    if (!contentType) {
      return Response.json({ error: "אפשר להעלות PDF, JPG, PNG או WebP בלבד." }, { status: 400 });
    }
    if (upload.size === 0 || upload.size > MAX_FILE_SIZE) {
      return Response.json({ error: "גודל הקובץ חייב להיות עד 20MB." }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const storageKey = `practice-library/${id}`;
    const name = upload.name.trim().slice(0, 180) || "קובץ ללא שם";
    const createdAt = new Date().toISOString();
    const storage = getLibraryStorage();

    await storage.put(storageKey, upload.stream());

    try {
      const file = await addLibraryFile({
        id,
        name,
        contentType,
        size: upload.size,
        section,
        folderId,
        storageKey,
        createdAt,
      });
      return Response.json({ file: publicFile(file) }, { status: 201 });
    } catch (error) {
      await storage.delete(storageKey);
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as {
      id?: unknown;
      name?: unknown;
      section?: unknown;
      folderId?: unknown;
    };
    if (typeof payload.id !== "string") {
      return Response.json({ error: "חסר מזהה קובץ." }, { status: 400 });
    }

    const hasName = Object.prototype.hasOwnProperty.call(payload, "name");
    const hasSection = Object.prototype.hasOwnProperty.call(payload, "section");
    const hasFolderId = Object.prototype.hasOwnProperty.call(payload, "folderId");
    if (!hasName && !hasSection && !hasFolderId) {
      return Response.json({ error: "לא נבחר שינוי לשמירה." }, { status: 400 });
    }

    const changes: { name?: string; section?: LibrarySection; folderId?: string | null } = {};
    if (hasName) {
      if (typeof payload.name !== "string" || !payload.name.trim()) {
        return Response.json({ error: "שם הקובץ לא יכול להיות ריק." }, { status: 400 });
      }
      changes.name = payload.name.trim().slice(0, 180);
    }
    if (hasSection) {
      if (!isLibrarySection(payload.section)) {
        return Response.json({ error: "הקטגוריה לא תקינה." }, { status: 400 });
      }
      changes.section = payload.section;
    }
    if (hasFolderId) {
      if (payload.folderId !== null && typeof payload.folderId !== "string") {
        return Response.json({ error: "התיקייה לא תקינה." }, { status: 400 });
      }
      changes.folderId = typeof payload.folderId === "string" && payload.folderId ? payload.folderId : null;
    }

    const file = await updateLibraryFile(payload.id, changes);
    if (!file) return Response.json({ error: "הקובץ לא נמצא." }, { status: 404 });
    return Response.json({ file: publicFile(file) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "חסר מזהה קובץ." }, { status: 400 });

    const deleted = await deleteLibraryFile(id);
    if (!deleted) return Response.json({ error: "הקובץ לא נמצא." }, { status: 404 });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
