export const LIBRARY_SECTION_ORDER = ["warmup", "practice", "personal"];

export function chooseInitialLibrarySelection(files, folders) {
  const section = LIBRARY_SECTION_ORDER.find((candidate) => (
    files.some((file) => file.section === candidate)
    || folders.some((folder) => folder.section === candidate)
  )) ?? "warmup";

  return {
    section,
    fileId: files.find((file) => file.section === section)?.id ?? null,
  };
}
