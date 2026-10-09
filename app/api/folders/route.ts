import {
  createLibraryFolder,
  deleteLibraryFolder,
  isLibrarySection,
  listLibraryFolders,
  updateLibraryFolder,
  type LibrarySection,
} from "../../../db/library";

function normalizeName(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "לא ניתן להשלים את הפעולה.";
  const status = message.includes("כבר קיימת") ? 409 : 500;
  return Response.json({ error: message }, { status });
}

export async function GET() {
  try {
    return Response.json({ folders: await listLibraryFolders() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { name?: unknown; section?: unknown };
    const name = normalizeName(payload.name);
    if (!name || !isLibrarySection(payload.section)) {
      return Response.json({ error: "יש לתת לתיקייה שם ולבחור קטגוריה." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const folder = await createLibraryFolder({
      id: crypto.randomUUID(),
      name,
      section: payload.section,
      createdAt: now,
      updatedAt: now,
    });
    return Response.json({ folder }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as { id?: unknown; name?: unknown; section?: unknown };
    if (typeof payload.id !== "string") {
      return Response.json({ error: "חסר מזהה תיקייה." }, { status: 400 });
    }

    const hasName = Object.prototype.hasOwnProperty.call(payload, "name");
    const hasSection = Object.prototype.hasOwnProperty.call(payload, "section");
    if (!hasName && !hasSection) {
      return Response.json({ error: "לא נבחר שינוי לשמירה." }, { status: 400 });
    }

    const changes: { name?: string; section?: LibrarySection } = {};
    if (hasName) {
      const name = normalizeName(payload.name);
      if (!name) return Response.json({ error: "שם התיקייה לא יכול להיות ריק." }, { status: 400 });
      changes.name = name;
    }
    if (hasSection) {
      if (!isLibrarySection(payload.section)) {
        return Response.json({ error: "הקטגוריה לא תקינה." }, { status: 400 });
      }
      changes.section = payload.section;
    }

    const folder = await updateLibraryFolder(payload.id, changes);
    if (!folder) return Response.json({ error: "התיקייה לא נמצאה." }, { status: 404 });
    return Response.json({ folder });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "חסר מזהה תיקייה." }, { status: 400 });

    const deleted = await deleteLibraryFolder(id);
    if (!deleted) return Response.json({ error: "התיקייה לא נמצאה." }, { status: 404 });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
