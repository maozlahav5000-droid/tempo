import {
  createLessonNote,
  deleteLessonNote,
  importLegacyLessonNoteIfEmpty,
  listLessonNotes,
  updateLessonNote,
} from "../../../db/notes";

const MAX_BODY_LENGTH = 250_000;

function normalizeTitle(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function normalizeDate(value: unknown) {
  if (value === "" || value === null || value === undefined) return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

function normalizeBody(value: unknown) {
  return typeof value === "string" && value.length <= MAX_BODY_LENGTH ? value : null;
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "לא ניתן להשלים את הפעולה.";
  return Response.json({ error: message }, { status: 500 });
}

export async function GET() {
  try {
    return Response.json({ notes: await listLessonNotes() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      mode?: unknown;
      title?: unknown;
      lessonDate?: unknown;
      bodyHtml?: unknown;
    };
    const title = normalizeTitle(payload.title) || "שיעור ללא שם";
    const lessonDate = normalizeDate(payload.lessonDate);
    const bodyHtml = normalizeBody(payload.bodyHtml ?? "");
    if (lessonDate === null || bodyHtml === null) {
      return Response.json({ error: "פרטי השיעור אינם תקינים." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const note = {
      id: crypto.randomUUID(),
      title,
      lessonDate,
      bodyHtml,
      createdAt: now,
      updatedAt: now,
    };
    if (payload.mode === "legacy-if-empty") {
      const imported = await importLegacyLessonNoteIfEmpty(note);
      return Response.json(imported, { status: imported.imported ? 201 : 200 });
    }

    await createLessonNote(note);
    return Response.json({ note }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as {
      id?: unknown;
      title?: unknown;
      lessonDate?: unknown;
      bodyHtml?: unknown;
    };
    if (typeof payload.id !== "string") {
      return Response.json({ error: "חסר מזהה שיעור." }, { status: 400 });
    }

    const hasTitle = Object.prototype.hasOwnProperty.call(payload, "title");
    const hasDate = Object.prototype.hasOwnProperty.call(payload, "lessonDate");
    const hasBody = Object.prototype.hasOwnProperty.call(payload, "bodyHtml");
    if (!hasTitle && !hasDate && !hasBody) {
      return Response.json({ error: "לא נבחר שינוי לשמירה." }, { status: 400 });
    }

    const changes: { title?: string; lessonDate?: string; bodyHtml?: string } = {};
    if (hasTitle) changes.title = normalizeTitle(payload.title) || "שיעור ללא שם";
    if (hasDate) {
      const lessonDate = normalizeDate(payload.lessonDate);
      if (lessonDate === null) return Response.json({ error: "התאריך אינו תקין." }, { status: 400 });
      changes.lessonDate = lessonDate;
    }
    if (hasBody) {
      const bodyHtml = normalizeBody(payload.bodyHtml);
      if (bodyHtml === null) return Response.json({ error: "תוכן ההערה אינו תקין." }, { status: 400 });
      changes.bodyHtml = bodyHtml;
    }

    const note = await updateLessonNote(payload.id, changes);
    if (!note) return Response.json({ error: "השיעור לא נמצא." }, { status: 404 });
    return Response.json({ note });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "חסר מזהה שיעור." }, { status: 400 });
    const deleted = await deleteLessonNote(id);
    if (!deleted) return Response.json({ error: "השיעור לא נמצא." }, { status: 404 });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
