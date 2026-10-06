"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ProjectsView, { type ProjectId } from "./components/ProjectsView";

const MIN_BPM = 40;
const MAX_BPM = 240;
const BPM_PRESETS = [50, 60] as const;
const MAX_LIBRARY_FILE_SIZE = 20 * 1024 * 1024;
const METER_OPTIONS = [7, 6, 5, 4, 3, 2, 1] as const;
const BEAT_UNIT_OPTIONS = [16, 8, 4, 2, 1] as const;
const METRONOME_CLICK_URLS = {
  accent: "/audio/metronome-accent.wav",
  beat: "/audio/metronome-beat.wav",
} as const;
type BeatsPerBar = (typeof METER_OPTIONS)[number];
type BeatUnit = (typeof BEAT_UNIT_OPTIONS)[number];
type ViewName = "metronome" | "notes" | "sheet" | "projects";
type SheetSection = "warmup" | "practice";
const ALL_FOLDERS = "all";

type LibraryFolder = {
  id: string;
  name: string;
  section: SheetSection;
  createdAt: string;
  updatedAt: string;
};

type LibraryFile = {
  id: string;
  name: string;
  url: string;
  contentType: string;
  size: number;
  section: SheetSection;
  folderId: string | null;
  createdAt: string;
};

type FolderForm = {
  mode: "create" | "edit";
  id?: string;
  name: string;
  section: SheetSection;
};

type FileForm = {
  id: string;
  name: string;
  section: SheetSection;
  folderId: string;
};

type FloatingMetronomePosition = {
  inlineStart: number;
  blockStart: number;
};

type MetronomeDragState = {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

type MetronomeClickBuffers = {
  accent: AudioBuffer;
  beat: AudioBuffer;
};

type ActiveMetronomeSource = {
  source: AudioScheduledSourceNode;
  gain: GainNode;
  cleanup: () => void;
};

type LessonNote = {
  id: string;
  title: string;
  lessonDate: string;
  bodyHtml: string;
  createdAt: string;
  updatedAt: string;
};

type LessonNoteChanges = Partial<Pick<LessonNote, "title" | "lessonDate" | "bodyHtml">>;
type NotesStatus = "loading" | "saving" | "saved" | "error";
type LegacyLessonNote = { title?: string; date?: string; notes?: string };

const LEGACY_NOTES_KEY = "tempo.lessonNotes.v1";
const LEGACY_NOTES_CHECKED_KEY = "tempo.lessonNotes.v2.checked";
const ACTIVE_LESSON_KEY = "tempo.activeLessonId.v1";
const MAX_NOTE_TEXT_LENGTH = 50_000;

const NOTE_FORMATS = [
  { code: "KeyB", command: "bold" },
  { code: "KeyU", command: "underline" },
  { code: "KeyI", command: "italic" },
] as const;

type NoteFormatCommand = (typeof NOTE_FORMATS)[number]["command"];

const SAFE_NOTE_TAGS = new Set(["P", "DIV", "BR", "B", "STRONG", "I", "EM", "U", "UL", "LI"]);
const DROP_NOTE_TAGS = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "IMG", "SVG", "MATH", "FORM", "INPUT", "BUTTON",
]);

function appendSanitizedNoteNode(source: Node, target: Node, output: Document) {
  if (source.nodeType === Node.TEXT_NODE) {
    target.appendChild(output.createTextNode(source.textContent ?? ""));
    return;
  }
  if (source.nodeType !== Node.ELEMENT_NODE) return;

  const element = source as Element;
  if (DROP_NOTE_TAGS.has(element.tagName)) return;
  if (!SAFE_NOTE_TAGS.has(element.tagName)) {
    for (const child of Array.from(element.childNodes)) appendSanitizedNoteNode(child, target, output);
    return;
  }

  const clean = output.createElement(element.tagName.toLowerCase());
  for (const child of Array.from(element.childNodes)) appendSanitizedNoteNode(child, clean, output);
  target.appendChild(clean);
}

function sanitizeNoteHtml(input: string) {
  if (typeof DOMParser === "undefined" || typeof document === "undefined") return "";
  const source = new DOMParser().parseFromString(input, "text/html");
  const output = document.implementation.createHTMLDocument("");
  const container = output.createElement("div");
  for (const node of Array.from(source.body.childNodes)) appendSanitizedNoteNode(node, container, output);
  return container.innerHTML;
}

function stripLeadingStarMarker(root: Node) {
  const text = root.textContent ?? "";
  const marker = text.match(/^[\s\u00a0]*\*(?:[\t \u00a0]+|$)/u)?.[0];
  if (!marker) return false;

  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  if (!walker) return false;
  let remaining = marker.length;
  let textNode = walker.nextNode();
  while (textNode && remaining > 0) {
    const value = textNode.textContent ?? "";
    if (remaining >= value.length) {
      remaining -= value.length;
      textNode.textContent = "";
    } else {
      textNode.textContent = value.slice(remaining);
      remaining = 0;
    }
    textNode = walker.nextNode();
  }
  return remaining === 0;
}

function normalizeStarredNoteLines(input: string) {
  const safeHtml = sanitizeNoteHtml(input);
  if (!safeHtml || typeof DOMParser === "undefined" || typeof document === "undefined") return safeHtml;

  const source = new DOMParser().parseFromString(safeHtml, "text/html");
  const output = document.implementation.createHTMLDocument("");
  const container = output.createElement("div");
  let activeList: HTMLUListElement | null = null;
  let inlineNodes: Node[] = [];

  const appendLine = (line: HTMLElement) => {
    if (stripLeadingStarMarker(line)) {
      if (!activeList) {
        activeList = output.createElement("ul");
        container.appendChild(activeList);
      }
      const item = output.createElement("li");
      while (line.firstChild) item.appendChild(line.firstChild);
      if (!item.childNodes.length) item.appendChild(output.createElement("br"));
      activeList.appendChild(item);
      return;
    }

    activeList = null;
    container.appendChild(line);
  };

  const flushInlineNodes = (preserveEmptyLine = false) => {
    if (!inlineNodes.length && !preserveEmptyLine) return;
    const line = output.createElement("div");
    for (const node of inlineNodes) line.appendChild(node);
    if (!line.childNodes.length) line.appendChild(output.createElement("br"));
    inlineNodes = [];
    appendLine(line);
  };

  const processNodes = (nodes: Node[]): void => {
    for (const child of nodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const element = child as Element;
        if (element.tagName === "UL") {
          flushInlineNodes();
          activeList = null;
          container.appendChild(output.importNode(element, true));
          continue;
        }
        if (element.tagName === "DIV" || element.tagName === "P") {
          flushInlineNodes();
          const children = Array.from(element.childNodes);
          processNodes(children);
          if (children.length) flushInlineNodes();
          else flushInlineNodes(true);
          continue;
        }
        if (element.tagName === "BR") {
          flushInlineNodes(true);
          continue;
        }
      }

      if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").includes("\n")) {
        const parts = (child.textContent ?? "").split("\n");
        parts.forEach((part, index) => {
          if (part) inlineNodes.push(output.createTextNode(part));
          if (index < parts.length - 1) flushInlineNodes(true);
        });
        continue;
      }

      inlineNodes.push(output.importNode(child, true));
    }
  };

  processNodes(Array.from(source.body.childNodes));
  flushInlineNodes();
  return container.innerHTML;
}

function convertStarPrefixAtCaret(editor: HTMLDivElement) {
  const selection = document.getSelection();
  if (!selection?.isCollapsed || !selection.anchorNode || !editor.contains(selection.anchorNode)) return false;
  if (!document.queryCommandSupported("insertUnorderedList")) return false;

  let line = selection.anchorNode.nodeType === Node.ELEMENT_NODE
    ? selection.anchorNode as HTMLElement
    : selection.anchorNode.parentElement;
  while (line && line !== editor && !["DIV", "P", "LI"].includes(line.tagName)) {
    line = line.parentElement;
  }
  if (!line || line.tagName === "LI") return false;

  const range = selection.getRangeAt(0);
  const prefixRange = range.cloneRange();
  prefixRange.selectNodeContents(line);
  try {
    prefixRange.setEnd(selection.anchorNode, selection.anchorOffset);
  } catch {
    return false;
  }
  if (!/^[\s\u00a0]*\*$/u.test(prefixRange.toString())) return false;

  selection.removeAllRanges();
  selection.addRange(prefixRange);
  document.execCommand("delete", false);
  document.execCommand("insertUnorderedList", false);
  return true;
}

function plainTextToNoteHtml(value: string) {
  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
  return escaped.replace(/\r?\n/g, "<br>");
}

function getTodayValue() {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
}

function isLessonDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function formatLessonDate(value: string) {
  return isLessonDate(value)
    ? new Date(`${value}T00:00:00`).toLocaleDateString("he-IL")
    : "ללא תאריך";
}

function formatLessonCount(count: number) {
  if (count === 0) return "אין שיעורים";
  if (count === 1) return "שיעור אחד";
  return `${count} שיעורים`;
}

function sortLessonNotes(notes: LessonNote[]) {
  return [...notes].sort((first, second) => {
    const firstHasDate = isLessonDate(first.lessonDate);
    const secondHasDate = isLessonDate(second.lessonDate);
    if (firstHasDate !== secondHasDate) return firstHasDate ? -1 : 1;
    if (firstHasDate && secondHasDate) {
      const dateOrder = first.lessonDate.localeCompare(second.lessonDate);
      if (dateOrder !== 0) return dateOrder;
    }
    const createdOrder = first.createdAt.localeCompare(second.createdAt);
    return createdOrder !== 0 ? createdOrder : first.id.localeCompare(second.id);
  });
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${new Intl.NumberFormat("he-IL", { maximumFractionDigits: 1 }).format(size / (1024 * 1024))} MB`;
}

function formatFileCount(count: number) {
  if (count === 0) return "אין קבצים";
  if (count === 1) return "קובץ אחד";
  return `${count} קבצים`;
}

async function readApiError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || "לא ניתן להשלים את הפעולה.";
  } catch {
    return "לא ניתן להשלים את הפעולה.";
  }
}

type BeatVisualProps = {
  beatsPerBar: BeatsPerBar;
  currentBeat: number | null;
  isPlaying: boolean;
  compact?: boolean;
};

function BeatVisual({ beatsPerBar, currentBeat, isPlaying, compact = false }: BeatVisualProps) {
  return (
    <span
      className={`beat-visual ${compact ? "compact" : ""}`}
      style={{ "--segment-size": `${360 / beatsPerBar}deg` } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="beat-track" />
      {Array.from({ length: beatsPerBar }, (_, beat) => (
        <span
          key={`${beatsPerBar}-${beat}`}
          className={`beat-segment ${isPlaying && currentBeat === beat ? "active" : ""}`}
          style={{
            "--segment-angle": `${beat * (360 / beatsPerBar)}deg`,
            "--segment-color": beat === 0 ? "#ff7b72" : "#45d5b0",
          } as React.CSSProperties}
        />
      ))}
      <span className="beat-core" />
    </span>
  );
}

function RichNotesEditor({
  initialHtml,
  onChange,
  onCommit,
  disabled = false,
}: {
  initialHtml: string;
  onChange: (html: string) => void;
  onCommit: () => void;
  disabled?: boolean;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const initialHtmlRef = useRef(initialHtml);
  const onChangeRef = useRef(onChange);
  const lastEmittedHtmlRef = useRef("");
  const [isEmpty, setIsEmpty] = useState(true);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const emitChange = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    setIsEmpty(!(editor.textContent ?? "").trim());
    const nextHtml = sanitizeNoteHtml(editor.innerHTML);
    if (nextHtml === lastEmittedHtmlRef.current) return;
    lastEmittedHtmlRef.current = nextHtml;
    onChangeRef.current(nextHtml);
  }, []);

  const applyFormat = useCallback((command: NoteFormatCommand) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus({ preventScroll: true });
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand(command, false);
    emitChange();
  }, [emitChange]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const safeHtml = normalizeStarredNoteLines(initialHtmlRef.current);
    editor.innerHTML = safeHtml;
    lastEmittedHtmlRef.current = safeHtml;
    setIsEmpty(!(editor.textContent ?? "").trim());
  }, []);

  return (
    <div
        ref={editorRef}
        id="lesson-notes-editor"
        className="rich-notes-editor"
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        tabIndex={0}
        aria-multiline="true"
        aria-label="תוכן הערות השיעור"
        aria-disabled={disabled}
        dir="rtl"
        lang="he"
        spellCheck
        data-empty={isEmpty}
        data-placeholder="כתבו כאן מה תרגלתם, דגשים מהמורה ומה כדאי להכין לשיעור הבא…"
        onBeforeInput={(event) => {
          const input = event.nativeEvent as InputEvent;
          if (!input.data) return;
          const editor = editorRef.current;
          const selection = document.getSelection();
          const selectedLength = editor && selection?.anchorNode && selection.focusNode
            && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)
            ? selection.toString().length
            : 0;
          const currentLength = editor?.textContent?.length ?? 0;
          if (currentLength - selectedLength + input.data.length > MAX_NOTE_TEXT_LENGTH) event.preventDefault();
        }}
        onInput={emitChange}
        onBlur={() => {
          const editor = editorRef.current;
          if (editor) {
            const normalizedHtml = normalizeStarredNoteLines(editor.innerHTML);
            if (normalizedHtml !== editor.innerHTML) editor.innerHTML = normalizedHtml;
          }
          emitChange();
          onCommit();
        }}
        onKeyDown={(event) => {
          if (
            event.key === " "
            && !(event.ctrlKey || event.metaKey || event.altKey)
            && editorRef.current
            && convertStarPrefixAtCaret(editorRef.current)
          ) {
            event.preventDefault();
            emitChange();
            return;
          }
          if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
          const format = NOTE_FORMATS.find((item) => item.code === event.code);
          if (!format) return;
          event.preventDefault();
          applyFormat(format.command);
        }}
        onPaste={(event) => {
          event.preventDefault();
          const currentLength = editorRef.current?.textContent?.length ?? 0;
          const selection = document.getSelection();
          const selectedLength = editorRef.current && selection?.anchorNode && selection.focusNode
            && editorRef.current.contains(selection.anchorNode) && editorRef.current.contains(selection.focusNode)
            ? selection.toString().length
            : 0;
          const availableLength = Math.max(0, MAX_NOTE_TEXT_LENGTH - currentLength + selectedLength);
          const text = event.clipboardData.getData("text/plain").slice(0, availableLength);
          document.execCommand("insertText", false, text);
          emitChange();
        }}
        onDrop={(event) => event.preventDefault()}
    />
  );
}

export default function Home() {
  const [activeView, setActiveView] = useState<ViewName>("metronome");
  const [activeProject, setActiveProject] = useState<ProjectId | null>(null);
  const [bpm, setBpm] = useState(60);
  const [bpmInput, setBpmInput] = useState("60");
  const [beatsPerBar, setBeatsPerBar] = useState<BeatsPerBar>(4);
  const [beatUnit, setBeatUnit] = useState<BeatUnit>(4);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentBeat, setCurrentBeat] = useState<number | null>(null);
  const [lessonEntries, setLessonEntries] = useState<LessonNote[]>([]);
  const [activeLessonId, setActiveLessonId] = useState<string | null>(null);
  const [notesStatus, setNotesStatus] = useState<NotesStatus>("loading");
  const [notesBusy, setNotesBusy] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [activeSheetSection, setActiveSheetSection] = useState<SheetSection>("warmup");
  const [libraryFiles, setLibraryFiles] = useState<LibraryFile[]>([]);
  const [libraryFolders, setLibraryFolders] = useState<LibraryFolder[]>([]);
  const [activeFolderFilter, setActiveFolderFilter] = useState(ALL_FOLDERS);
  const [selectedSheetId, setSelectedSheetId] = useState<string | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [librarySaving, setLibrarySaving] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [folderForm, setFolderForm] = useState<FolderForm | null>(null);
  const [fileForm, setFileForm] = useState<FileForm | null>(null);
  const [isSheetExpanded, setIsSheetExpanded] = useState(false);
  const [floatingMetronomePosition, setFloatingMetronomePosition] = useState<FloatingMetronomePosition | null>(null);
  const [isDraggingMetronome, setIsDraggingMetronome] = useState(false);
  const [isFloatingMetronomeMinimized, setIsFloatingMetronomeMinimized] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const metronomeOutputRef = useRef<GainNode | null>(null);
  const clickBuffersRef = useRef<MetronomeClickBuffers | null>(null);
  const clickBuffersPromiseRef = useRef<Promise<MetronomeClickBuffers> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextNoteTimeRef = useRef(0);
  const beatRef = useRef(0);
  const bpmRef = useRef(bpm);
  const beatsPerBarRef = useRef<BeatsPerBar>(beatsPerBar);
  const sourcesRef = useRef(new Set<ActiveMetronomeSource>());
  const visualTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const generationRef = useRef(0);
  const runningRef = useRef(false);
  const startingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sheetFrameRef = useRef<HTMLDivElement | null>(null);
  const floatingMetronomeRef = useRef<HTMLElement | null>(null);
  const metronomeDragRef = useRef<MetronomeDragState | null>(null);
  const metronomeDragFrameRef = useRef<number | null>(null);
  const pendingMetronomePositionRef = useRef<FloatingMetronomePosition | null>(null);
  const lessonSaveTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingLessonChangesRef = useRef(new Map<string, LessonNoteChanges>());
  const lessonSaveInFlightRef = useRef(new Map<string, Promise<void>>());
  const lessonSaveRequestsRef = useRef(0);

  const activeLesson = lessonEntries.find((lesson) => lesson.id === activeLessonId) ?? null;

  const placeFloatingMetronome = useCallback((left: number, top: number, width: number, height: number) => {
    const visualViewport = window.visualViewport;
    const rootStyle = window.getComputedStyle(document.documentElement);
    const safeAreaTop = Number.parseFloat(rootStyle.getPropertyValue("--safe-area-top")) || 0;
    const safeAreaRight = Number.parseFloat(rootStyle.getPropertyValue("--safe-area-right")) || 0;
    const safeAreaBottom = Number.parseFloat(rootStyle.getPropertyValue("--safe-area-bottom")) || 0;
    const safeAreaLeft = Number.parseFloat(rootStyle.getPropertyValue("--safe-area-left")) || 0;
    const viewportLeft = visualViewport?.offsetLeft ?? 0;
    const viewportTop = visualViewport?.offsetTop ?? 0;
    const viewportWidth = visualViewport?.width ?? document.documentElement.clientWidth ?? window.innerWidth;
    const viewportHeight = visualViewport?.height ?? window.innerHeight;
    const viewportRight = viewportLeft + viewportWidth;
    const viewportBottom = viewportTop + viewportHeight;
    const mobileNav = window.matchMedia("(max-width: 980px)").matches
      ? document.querySelector<HTMLElement>(".studio-sidebar")
      : null;
    const mobileNavTop = mobileNav?.getBoundingClientRect().top;
    const safeViewportBottom = viewportBottom - safeAreaBottom;
    const unobstructedBottom = typeof mobileNavTop === "number" && mobileNavTop > viewportTop
      ? Math.min(safeViewportBottom, mobileNavTop)
      : safeViewportBottom;
    const minLeft = viewportLeft + Math.max(8, safeAreaLeft);
    const minTop = viewportTop + Math.max(8, safeAreaTop);
    const maxLeft = Math.max(minLeft, viewportRight - width - Math.max(8, safeAreaRight));
    const maxTop = Math.max(minTop, unobstructedBottom - height - 8);
    const safeLeft = Math.min(maxLeft, Math.max(minLeft, left));
    const safeTop = Math.min(maxTop, Math.max(minTop, top));
    const layoutViewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const inlineStart = document.documentElement.dir === "rtl"
      ? layoutViewportWidth - safeLeft - width
      : safeLeft;
    pendingMetronomePositionRef.current = {
      inlineStart: Math.max(8, Math.round(inlineStart)),
      blockStart: Math.round(safeTop),
    };
    if (metronomeDragFrameRef.current !== null) return;
    metronomeDragFrameRef.current = window.requestAnimationFrame(() => {
      metronomeDragFrameRef.current = null;
      const next = pendingMetronomePositionRef.current;
      if (next) setFloatingMetronomePosition(next);
    });
  }, []);

  const beginMetronomeDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const panel = floatingMetronomeRef.current;
    if (!panel) return;
    const bounds = panel.getBoundingClientRect();
    metronomeDragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDraggingMetronome(true);
    event.preventDefault();
  };

  const moveMetronomeDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = metronomeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    placeFloatingMetronome(
      event.clientX - drag.offsetX,
      event.clientY - drag.offsetY,
      drag.width,
      drag.height,
    );
  };

  const endMetronomeDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = metronomeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    metronomeDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDraggingMetronome(false);
  };

  const moveFloatingMetronomeBy = (horizontalDelta: number, verticalDelta: number) => {
    const panel = floatingMetronomeRef.current;
    if (!panel) return;
    const bounds = panel.getBoundingClientRect();
    placeFloatingMetronome(
      bounds.left + horizontalDelta,
      bounds.top + verticalDelta,
      bounds.width,
      bounds.height,
    );
  };

  const clearVisualTimers = useCallback(() => {
    for (const timer of visualTimersRef.current) clearTimeout(timer);
    visualTimersRef.current.clear();
  }, []);

  const clearScheduledAudio = useCallback((fadeOut = false) => {
    const sources = Array.from(sourcesRef.current);
    sourcesRef.current.clear();
    const context = audioContextRef.current;
    const canFade = fadeOut && context && context.state !== "closed";
    const now = canFade ? context.currentTime : 0;

    for (const activeSource of sources) {
      try {
        if (canFade) {
          activeSource.gain.gain.cancelScheduledValues(now);
          activeSource.gain.gain.setValueAtTime(
            Math.max(0.0001, activeSource.gain.gain.value),
            now,
          );
          activeSource.gain.gain.linearRampToValueAtTime(0.0001, now + 0.008);
          activeSource.source.stop(now + 0.012);
        } else {
          activeSource.source.onended = null;
          activeSource.source.stop();
          activeSource.cleanup();
        }
      } catch {
        // The short metronome click may already have ended.
        activeSource.cleanup();
      }
    }
  }, []);

  const stopMetronome = useCallback(() => {
    generationRef.current += 1;
    runningRef.current = false;
    startingRef.current = false;
    beatRef.current = 0;

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    clearScheduledAudio(true);
    clearVisualTimers();
    setCurrentBeat(null);
    setIsPlaying(false);
  }, [clearScheduledAudio, clearVisualTimers]);

  const loadClickBuffers = useCallback((context: AudioContext) => {
    if (clickBuffersRef.current) return Promise.resolve(clickBuffersRef.current);
    if (clickBuffersPromiseRef.current) return clickBuffersPromiseRef.current;

    const loadBuffer = async (url: string) => {
      const response = await fetch(url, { cache: "force-cache" });
      if (!response.ok) throw new Error(`Unable to load metronome sound: ${response.status}`);
      return context.decodeAudioData(await response.arrayBuffer());
    };

    const pending = Promise.all([
      loadBuffer(METRONOME_CLICK_URLS.accent),
      loadBuffer(METRONOME_CLICK_URLS.beat),
    ])
      .then(([accent, beat]) => {
        const buffers = { accent, beat };
        clickBuffersRef.current = buffers;
        return buffers;
      })
      .catch((error) => {
        clickBuffersPromiseRef.current = null;
        throw error;
      });

    clickBuffersPromiseRef.current = pending;
    return pending;
  }, []);

  const scheduleClick = useCallback((beat: number, time: number) => {
    const context = audioContextRef.current;
    if (!context) return;

    const destination = metronomeOutputRef.current ?? context.destination;
    const isAccent = beat === 0;
    const buffer = isAccent ? clickBuffersRef.current?.accent : clickBuffersRef.current?.beat;
    if (buffer) {
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.setValueAtTime(1, time);
      source.connect(gain);
      gain.connect(destination);
      const activeSource: ActiveMetronomeSource = {
        source,
        gain,
        cleanup: () => {
          sourcesRef.current.delete(activeSource);
          source.disconnect();
          gain.disconnect();
        },
      };
      sourcesRef.current.add(activeSource);
      source.onended = () => {
        activeSource.cleanup();
      };
      source.start(time);
      return;
    }

    // Quiet fallback for an unavailable sample. The shipped WAV files are the normal path.
    const oscillator = context.createOscillator();
    const tone = context.createBiquadFilter();
    const gain = context.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(isAccent ? 1500 : 1000, time);
    oscillator.frequency.exponentialRampToValueAtTime(isAccent ? 1080 : 720, time + 0.08);
    tone.type = "lowpass";
    tone.frequency.setValueAtTime(2800, time);
    tone.Q.setValueAtTime(0.7, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(isAccent ? 0.52 : 0.46, time + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.14);

    oscillator.connect(tone);
    tone.connect(gain);
    gain.connect(destination);
    const activeSource: ActiveMetronomeSource = {
      source: oscillator,
      gain,
      cleanup: () => {
        sourcesRef.current.delete(activeSource);
        oscillator.disconnect();
        tone.disconnect();
        gain.disconnect();
      },
    };
    sourcesRef.current.add(activeSource);
    oscillator.onended = () => {
      activeSource.cleanup();
    };
    oscillator.start(time);
    oscillator.stop(time + 0.145);
  }, []);

  const scheduleVisualBeat = useCallback((beat: number, time: number) => {
    const context = audioContextRef.current;
    if (!context) return;

    const delay = Math.max(0, (time - context.currentTime) * 1000);
    const timer = setTimeout(() => {
      visualTimersRef.current.delete(timer);
      if (runningRef.current) setCurrentBeat(beat % beatsPerBarRef.current);
    }, delay);
    visualTimersRef.current.add(timer);
  }, []);

  const startMetronome = useCallback(async () => {
    if (runningRef.current || startingRef.current) return;

    const AudioContextClass =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;

    if (!AudioContextClass) return;

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    startingRef.current = true;

    try {
      if (!audioContextRef.current) audioContextRef.current = new AudioContextClass();
      const context = audioContextRef.current;
      if (context.state === "suspended") await context.resume();
      if (!metronomeOutputRef.current) {
        const output = context.createGain();
        output.connect(context.destination);
        metronomeOutputRef.current = output;
      }
      metronomeOutputRef.current.gain.cancelScheduledValues(context.currentTime);
      metronomeOutputRef.current.gain.setValueAtTime(1, context.currentTime);
      try {
        await loadClickBuffers(context);
      } catch {
        // Keep the metronome usable with the softer synthesized fallback.
      }
      if (generation !== generationRef.current) return;

      startingRef.current = false;
      runningRef.current = true;
      beatRef.current = 0;
      setCurrentBeat(null);
      clearVisualTimers();
      nextNoteTimeRef.current = context.currentTime + 0.05;

      const scheduler = () => {
        const currentContext = audioContextRef.current;
        if (!currentContext || !runningRef.current || generation !== generationRef.current) return;

        const secondsPerBeat = 60 / bpmRef.current;
        if (nextNoteTimeRef.current < currentContext.currentTime - 0.02) {
          const missedBeats = Math.floor(
            (currentContext.currentTime - nextNoteTimeRef.current) / secondsPerBeat,
          ) + 1;
          nextNoteTimeRef.current += missedBeats * secondsPerBeat;
          beatRef.current = (beatRef.current + missedBeats) % beatsPerBarRef.current;
        }

        while (nextNoteTimeRef.current < currentContext.currentTime + 0.1) {
          scheduleClick(beatRef.current, nextNoteTimeRef.current);
          scheduleVisualBeat(beatRef.current, nextNoteTimeRef.current);
          nextNoteTimeRef.current += secondsPerBeat;
          beatRef.current = (beatRef.current + 1) % beatsPerBarRef.current;
        }
      };

      scheduler();
      timerRef.current = setInterval(scheduler, 25);
      setIsPlaying(true);
    } catch {
      startingRef.current = false;
      runningRef.current = false;
      setIsPlaying(false);
    }
  }, [clearVisualTimers, loadClickBuffers, scheduleClick, scheduleVisualBeat]);

  const toggleMetronome = useCallback(() => {
    if (runningRef.current || startingRef.current) stopMetronome();
    else void startMetronome();
  }, [startMetronome, stopMetronome]);

  const flushLessonSave = useCallback((id: string, keepalive = false) => {
    const timer = lessonSaveTimersRef.current.get(id);
    if (timer) clearTimeout(timer);
    lessonSaveTimersRef.current.delete(id);

    const activeRequest = lessonSaveInFlightRef.current.get(id);
    if (activeRequest) return activeRequest;
    if (!pendingLessonChangesRef.current.has(id)) return Promise.resolve();

    setNotesStatus("saving");
    const operation = (async () => {
      while (pendingLessonChangesRef.current.has(id)) {
        const pendingChanges = pendingLessonChangesRef.current.get(id);
        if (!pendingChanges) break;
        pendingLessonChangesRef.current.delete(id);
        lessonSaveRequestsRef.current += 1;

        try {
          const response = await fetch("/api/notes", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, ...pendingChanges }),
            keepalive,
          });
          if (!response.ok) throw new Error(await readApiError(response));
          const payload = (await response.json()) as { note: LessonNote };
          const newerChanges = pendingLessonChangesRef.current.get(id) ?? {};
          setLessonEntries((current) => sortLessonNotes(current.map((lesson) => {
            if (lesson.id !== id) return lesson;
            return {
              ...lesson,
              ...("title" in pendingChanges && !("title" in newerChanges) ? { title: payload.note.title } : {}),
              ...("lessonDate" in pendingChanges && !("lessonDate" in newerChanges) ? { lessonDate: payload.note.lessonDate } : {}),
              ...("bodyHtml" in pendingChanges && !("bodyHtml" in newerChanges)
                ? { bodyHtml: sanitizeNoteHtml(payload.note.bodyHtml) }
                : {}),
              updatedAt: payload.note.updatedAt,
            };
          })));
        } catch (error) {
          const newerChanges = pendingLessonChangesRef.current.get(id) ?? {};
          pendingLessonChangesRef.current.set(id, { ...pendingChanges, ...newerChanges });
          setNotesStatus("error");
          setNotesError(error instanceof Error ? error.message : "לא ניתן לשמור את השיעור.");
          break;
        } finally {
          lessonSaveRequestsRef.current -= 1;
        }
      }
    })();

    lessonSaveInFlightRef.current.set(id, operation);
    void operation.finally(() => {
      if (lessonSaveInFlightRef.current.get(id) === operation) lessonSaveInFlightRef.current.delete(id);
      if (
        lessonSaveRequestsRef.current === 0
        && lessonSaveInFlightRef.current.size === 0
        && lessonSaveTimersRef.current.size === 0
        && pendingLessonChangesRef.current.size === 0
      ) {
        setNotesStatus("saved");
      }
    });
    return operation;
  }, []);

  const queueLessonSave = useCallback((id: string, changes: LessonNoteChanges) => {
    const currentChanges = pendingLessonChangesRef.current.get(id) ?? {};
    pendingLessonChangesRef.current.set(id, { ...currentChanges, ...changes });

    const currentTimer = lessonSaveTimersRef.current.get(id);
    if (currentTimer) clearTimeout(currentTimer);
    setNotesStatus("saving");
    setNotesError(null);

    const timer = setTimeout(() => {
      lessonSaveTimersRef.current.delete(id);
      void flushLessonSave(id);
    }, 550);
    lessonSaveTimersRef.current.set(id, timer);
  }, [flushLessonSave]);

  const loadLessonNotes = useCallback(async () => {
    setNotesStatus("loading");
    setNotesError(null);

    const fetchNotes = async () => {
      const response = await fetch("/api/notes", { cache: "no-store" });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as { notes?: LessonNote[] };
      return Array.isArray(payload.notes) ? payload.notes : [];
    };

    try {
      let notes = await fetchNotes();
      let legacyChecked = false;
      try {
        legacyChecked = window.localStorage.getItem(LEGACY_NOTES_CHECKED_KEY) === "true";
      } catch {
        // The database remains the source of truth when browser storage is unavailable.
      }

      if (!notes.length && !legacyChecked) {
        let legacy: LegacyLessonNote | null = null;
        try {
          const saved = window.localStorage.getItem(LEGACY_NOTES_KEY);
          legacy = saved ? JSON.parse(saved) as LegacyLessonNote : null;
        } catch {
          legacy = null;
        }

        if (legacy && (legacy.title?.trim() || legacy.date || legacy.notes?.trim())) {
          const response = await fetch("/api/notes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "legacy-if-empty",
              title: legacy.title || "שיעור ללא שם",
              lessonDate: legacy.date && isLessonDate(legacy.date) ? legacy.date : "",
              bodyHtml: plainTextToNoteHtml(legacy.notes ?? ""),
            }),
          });
          if (!response.ok) throw new Error(await readApiError(response));
          notes = await fetchNotes();
          try {
            window.localStorage.removeItem(LEGACY_NOTES_KEY);
            window.localStorage.setItem(LEGACY_NOTES_CHECKED_KEY, "true");
          } catch {
            // Successful migration does not depend on local preference cleanup.
          }
        } else {
          try {
            window.localStorage.setItem(LEGACY_NOTES_CHECKED_KEY, "true");
          } catch {
            // No legacy note needs migration.
          }
        }
      } else if (notes.length) {
        try {
          window.localStorage.setItem(LEGACY_NOTES_CHECKED_KEY, "true");
        } catch {
          // This marker is only a browser preference.
        }
      }

      if (!notes.length) {
        const response = await fetch("/api/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "שיעור חדש", lessonDate: getTodayValue(), bodyHtml: "" }),
        });
        if (!response.ok) throw new Error(await readApiError(response));
        const payload = (await response.json()) as { note: LessonNote };
        notes = [payload.note];
      }

      const safeNotes = sortLessonNotes(notes.map((note) => ({
        ...note,
        bodyHtml: sanitizeNoteHtml(note.bodyHtml),
      })));
      let preferredId: string | null = null;
      try {
        preferredId = window.localStorage.getItem(ACTIVE_LESSON_KEY);
      } catch {
        preferredId = null;
      }
      const nextActiveId = preferredId && safeNotes.some((note) => note.id === preferredId)
        ? preferredId
        : safeNotes[0]?.id ?? null;
      setLessonEntries(safeNotes);
      setActiveLessonId(nextActiveId);
      setNotesStatus("saved");
    } catch (error) {
      setNotesStatus("error");
      setNotesError(error instanceof Error ? error.message : "לא ניתן לטעון את השיעורים.");
    }
  }, []);

  const retryLessonNotes = () => {
    setNotesError(null);
    const pendingIds = Array.from(pendingLessonChangesRef.current.keys());
    if (pendingIds.length) {
      setNotesStatus("saving");
      for (const id of pendingIds) void flushLessonSave(id);
      return;
    }
    void loadLessonNotes();
  };

  const loadLibrary = useCallback(async () => {
    setLibraryLoading(true);
    try {
      const response = await fetch("/api/library", { cache: "no-store" });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as { files?: LibraryFile[]; folders?: LibraryFolder[] };
      const files = Array.isArray(payload.files) ? payload.files : [];
      const folders = Array.isArray(payload.folders) ? payload.folders : [];
      setLibraryFiles(files);
      setLibraryFolders(folders);
      setActiveFolderFilter((current) => {
        if (current === ALL_FOLDERS || folders.some((folder) => folder.id === current)) return current;
        return ALL_FOLDERS;
      });
      setActiveSheetSection(
        files.some((file) => file.section === "warmup") || folders.some((folder) => folder.section === "warmup")
          ? "warmup"
          : files[0]?.section ?? folders[0]?.section ?? "warmup",
      );
      setSelectedSheetId((current) => {
        if (current && files.some((file) => file.id === current)) return current;
        return files.find((file) => file.section === "warmup")?.id ?? files[0]?.id ?? null;
      });
      setLibraryError(null);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "לא ניתן לטעון את מאגר הקבצים.");
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing = Boolean(target?.closest("input, textarea, button, select, [contenteditable='true']"));
      if (activeView === "metronome" && event.code === "Space" && !isEditing) {
        event.preventDefault();
        toggleMetronome();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeView, toggleMetronome]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadLibrary(), 0);
    return () => window.clearTimeout(timer);
  }, [loadLibrary]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadLessonNotes(), 0);
    return () => window.clearTimeout(timer);
  }, [loadLessonNotes]);

  useEffect(() => {
    const flushPendingNotes = () => {
      for (const id of pendingLessonChangesRef.current.keys()) void flushLessonSave(id, true);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushPendingNotes();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", flushPendingNotes);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", flushPendingNotes);
    };
  }, [flushLessonSave]);

  useEffect(() => {
    if (!isSheetExpanded) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsSheetExpanded(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isSheetExpanded]);

  useEffect(() => {
    const keepFloatingMetronomeVisible = () => {
      const panel = floatingMetronomeRef.current;
      if (!panel) return;
      const bounds = panel.getBoundingClientRect();
      placeFloatingMetronome(bounds.left, bounds.top, bounds.width, bounds.height);
    };

    window.addEventListener("resize", keepFloatingMetronomeVisible);
    window.visualViewport?.addEventListener("resize", keepFloatingMetronomeVisible);
    window.visualViewport?.addEventListener("scroll", keepFloatingMetronomeVisible);
    return () => {
      window.removeEventListener("resize", keepFloatingMetronomeVisible);
      window.visualViewport?.removeEventListener("resize", keepFloatingMetronomeVisible);
      window.visualViewport?.removeEventListener("scroll", keepFloatingMetronomeVisible);
    };
  }, [placeFloatingMetronome]);

  useEffect(() => {
    const compactLandscape = window.matchMedia("(max-width: 980px) and (orientation: landscape) and (max-height: 520px)");
    const matchMetronomeToViewport = () => {
      setIsFloatingMetronomeMinimized(compactLandscape.matches);
    };

    matchMetronomeToViewport();
    compactLandscape.addEventListener("change", matchMetronomeToViewport);
    return () => compactLandscape.removeEventListener("change", matchMetronomeToViewport);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const panel = floatingMetronomeRef.current;
      if (!panel) return;
      const bounds = panel.getBoundingClientRect();
      placeFloatingMetronome(bounds.left, bounds.top, bounds.width, bounds.height);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, isFloatingMetronomeMinimized, placeFloatingMetronome]);

  useEffect(() => {
    const pendingLessonChanges = pendingLessonChangesRef.current;
    const lessonSaveTimers = lessonSaveTimersRef.current;
    return () => {
      generationRef.current += 1;
      runningRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      if (metronomeDragFrameRef.current !== null) cancelAnimationFrame(metronomeDragFrameRef.current);
      for (const id of pendingLessonChanges.keys()) void flushLessonSave(id, true);
      for (const timer of lessonSaveTimers.values()) clearTimeout(timer);
      lessonSaveTimers.clear();
      clearScheduledAudio();
      clearVisualTimers();
      metronomeOutputRef.current?.disconnect();
      metronomeOutputRef.current = null;
      void audioContextRef.current?.close();
    };
  }, [clearScheduledAudio, clearVisualTimers, flushLessonSave]);

  const updateBpm = (value: number) => {
    const nextBpm = Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, value)));
    bpmRef.current = nextBpm;
    setBpm(nextBpm);
    setBpmInput(String(nextBpm));
  };

  const handleBpmInput = (value: string) => {
    setBpmInput(value);
    const parsed = Number(value);
    if (value !== "" && Number.isFinite(parsed) && parsed >= MIN_BPM && parsed <= MAX_BPM) {
      const nextBpm = Math.round(parsed);
      bpmRef.current = nextBpm;
      setBpm(nextBpm);
    }
  };

  const commitBpmInput = () => {
    const parsed = Number(bpmInput);
    updateBpm(Number.isFinite(parsed) && bpmInput !== "" ? parsed : bpm);
  };

  const updateMeter = (value: BeatsPerBar) => {
    beatsPerBarRef.current = value;
    beatRef.current = 0;
    setCurrentBeat(null);
    setBeatsPerBar(value);
  };

  const updateActiveLesson = (changes: LessonNoteChanges) => {
    if (!activeLessonId) return;
    setLessonEntries((current) => sortLessonNotes(current.map((lesson) => (
      lesson.id === activeLessonId
        ? { ...lesson, ...changes, updatedAt: new Date().toISOString() }
        : lesson
    ))));
    queueLessonSave(activeLessonId, changes);
  };

  const selectLesson = (id: string) => {
    if (activeLessonId && activeLessonId !== id) void flushLessonSave(activeLessonId);
    setActiveLessonId(id);
    setNotesError(null);
    try {
      window.localStorage.setItem(ACTIVE_LESSON_KEY, id);
    } catch {
      // The selected lesson is only a browser preference.
    }
  };

  const createNewLesson = async () => {
    setNotesBusy(true);
    setNotesStatus("saving");
    setNotesError(null);
    try {
      if (activeLessonId) await flushLessonSave(activeLessonId);
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "שיעור חדש", lessonDate: getTodayValue(), bodyHtml: "" }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as { note: LessonNote };
      setLessonEntries((current) => sortLessonNotes([...current, payload.note]));
      selectLesson(payload.note.id);
      if (
        lessonSaveRequestsRef.current === 0
        && lessonSaveInFlightRef.current.size === 0
        && lessonSaveTimersRef.current.size === 0
        && pendingLessonChangesRef.current.size === 0
      ) setNotesStatus("saved");
    } catch (error) {
      setNotesStatus("error");
      setNotesError(error instanceof Error ? error.message : "לא ניתן ליצור שיעור חדש.");
    } finally {
      setNotesBusy(false);
    }
  };

  const removeActiveLesson = async () => {
    if (!activeLesson || !window.confirm(`למחוק את “${activeLesson.title || "שיעור ללא שם"}”?`)) return;

    const id = activeLesson.id;
    let pendingChanges = pendingLessonChangesRef.current.get(id);
    const pendingTimer = lessonSaveTimersRef.current.get(id);
    if (pendingTimer) clearTimeout(pendingTimer);
    lessonSaveTimersRef.current.delete(id);
    pendingLessonChangesRef.current.delete(id);
    setNotesBusy(true);
    setNotesStatus("saving");
    setNotesError(null);

    try {
      const activeSave = lessonSaveInFlightRef.current.get(id);
      if (activeSave) await activeSave;
      const changesRestoredByFailedSave = pendingLessonChangesRef.current.get(id);
      if (changesRestoredByFailedSave) pendingChanges = { ...(pendingChanges ?? {}), ...changesRestoredByFailedSave };
      pendingLessonChangesRef.current.delete(id);
      const response = await fetch(`/api/notes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readApiError(response));
      const remaining = sortLessonNotes(lessonEntries.filter((lesson) => lesson.id !== id));
      const nextActiveId = remaining[0]?.id ?? null;
      setLessonEntries(remaining);
      setActiveLessonId(nextActiveId);
      try {
        if (nextActiveId) window.localStorage.setItem(ACTIVE_LESSON_KEY, nextActiveId);
        else window.localStorage.removeItem(ACTIVE_LESSON_KEY);
      } catch {
        // The selected lesson is only a browser preference.
      }
      if (
        lessonSaveRequestsRef.current === 0
        && lessonSaveInFlightRef.current.size === 0
        && lessonSaveTimersRef.current.size === 0
        && pendingLessonChangesRef.current.size === 0
      ) setNotesStatus("saved");
    } catch (error) {
      if (pendingChanges) queueLessonSave(id, pendingChanges);
      setNotesStatus("error");
      setNotesError(error instanceof Error ? error.message : "לא ניתן למחוק את השיעור.");
    } finally {
      setNotesBusy(false);
    }
  };

  const handleSheetFiles = async (files: File[], section: SheetSection) => {
    if (!files.length) return;

    const selectedFolder = libraryFolders.find(
      (folder) => folder.id === activeFolderFilter && folder.section === section,
    );
    const uploaded: LibraryFile[] = [];
    const failures: string[] = [];

    setLibrarySaving(true);
    setLibraryError(null);

    try {
      for (const file of files) {
        const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
        const isImage = ["image/png", "image/jpeg", "image/webp"].includes(file.type)
          || /\.(png|jpe?g|webp)$/i.test(file.name);

        if (!isPdf && !isImage) {
          failures.push(`${file.name}: סוג קובץ לא נתמך`);
          continue;
        }
        if (file.size === 0 || file.size > MAX_LIBRARY_FILE_SIZE) {
          failures.push(`${file.name}: גודל הקובץ חייב להיות עד 20MB`);
          continue;
        }

        try {
          const formData = new FormData();
          formData.append("file", file);
          formData.append("section", section);
          if (selectedFolder) formData.append("folderId", selectedFolder.id);

          const response = await fetch("/api/library", { method: "POST", body: formData });
          if (!response.ok) throw new Error(await readApiError(response));
          const payload = (await response.json()) as { file: LibraryFile };
          uploaded.push(payload.file);
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : "ההעלאה נכשלה"}`);
        }
      }

      if (uploaded.length) {
        const uploadedIds = new Set(uploaded.map((file) => file.id));
        const firstFile = uploaded[0];
        setLibraryFiles((current) => [
          ...uploaded,
          ...current.filter((file) => !uploadedIds.has(file.id)),
        ]);
        setActiveSheetSection(firstFile.section);
        if (firstFile.folderId) setActiveFolderFilter(firstFile.folderId);
        setSelectedSheetId(firstFile.id);
      }

      if (failures.length) {
        const visibleFailures = failures.slice(0, 3).join(" • ");
        const remainingFailures = failures.length > 3 ? ` • ועוד ${failures.length - 3}` : "";
        const successMessage = uploaded.length === 1
          ? "הועלה קובץ אחד. "
          : uploaded.length > 1
            ? `הועלו ${uploaded.length} קבצים. `
            : "";
        setLibraryError(`${successMessage}${visibleFailures}${remainingFailures}`);
      }
    } finally {
      setLibrarySaving(false);
    }
  };

  const saveFolder = async () => {
    if (!folderForm?.name.trim()) {
      setLibraryError("יש לתת לתיקייה שם.");
      return;
    }

    setLibrarySaving(true);
    try {
      const response = await fetch("/api/folders", {
        method: folderForm.mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(folderForm.id ? { id: folderForm.id } : {}),
          name: folderForm.name,
          section: folderForm.section,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as { folder: LibraryFolder };
      setLibraryFolders((current) => {
        const next = folderForm.mode === "create"
          ? [...current, payload.folder]
          : current.map((folder) => (folder.id === payload.folder.id ? payload.folder : folder));
        return next.sort((a, b) => a.name.localeCompare(b.name, "he"));
      });
      if (folderForm.mode === "edit") {
        setLibraryFiles((current) => current.map((file) => (
          file.folderId === payload.folder.id ? { ...file, section: payload.folder.section } : file
        )));
      }
      setActiveSheetSection(payload.folder.section);
      setActiveFolderFilter(payload.folder.id);
      setFolderForm(null);
      setLibraryError(null);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "לא ניתן לשמור את התיקייה.");
    } finally {
      setLibrarySaving(false);
    }
  };

  const removeFolder = async (folder: LibraryFolder) => {
    const fileCount = libraryFiles.filter((file) => file.folderId === folder.id).length;
    const detail = fileCount
      ? ` ${formatFileCount(fileCount)} יישארו תחת “כל הקבצים”.`
      : "";
    if (!window.confirm(`למחוק את התיקייה “${folder.name}”?${detail}`)) return;

    setLibrarySaving(true);
    try {
      const response = await fetch(`/api/folders?id=${encodeURIComponent(folder.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readApiError(response));
      setLibraryFolders((current) => current.filter((item) => item.id !== folder.id));
      setLibraryFiles((current) => current.map((file) => (
        file.folderId === folder.id ? { ...file, folderId: null } : file
      )));
      if (activeFolderFilter === folder.id) setActiveFolderFilter(ALL_FOLDERS);
      setFolderForm(null);
      setLibraryError(null);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "לא ניתן למחוק את התיקייה.");
    } finally {
      setLibrarySaving(false);
    }
  };

  const saveFile = async () => {
    if (!fileForm?.name.trim()) {
      setLibraryError("שם הקובץ לא יכול להיות ריק.");
      return;
    }

    setLibrarySaving(true);
    try {
      const response = await fetch("/api/library", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: fileForm.id,
          name: fileForm.name,
          section: fileForm.section,
          folderId: fileForm.folderId || null,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as { file: LibraryFile };
      setLibraryFiles((current) => current.map((item) => (item.id === payload.file.id ? payload.file : item)));
      setActiveSheetSection(payload.file.section);
      setActiveFolderFilter(payload.file.folderId ?? ALL_FOLDERS);
      setSelectedSheetId(payload.file.id);
      setFileForm(null);
      setLibraryError(null);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "לא ניתן לשמור את הקובץ.");
    } finally {
      setLibrarySaving(false);
    }
  };

  const removeSheetFile = async (file: LibraryFile) => {
    if (!window.confirm(`למחוק את הקובץ “${file.name}” מהמאגר?`)) return;
    setLibrarySaving(true);
    try {
      const response = await fetch(`/api/library?id=${encodeURIComponent(file.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readApiError(response));
      const remaining = libraryFiles.filter((item) => item.id !== file.id);
      setLibraryFiles(remaining);
      if (selectedSheetId === file.id) {
        setSelectedSheetId(remaining.find((item) => (
          item.section === activeSheetSection
          && (activeFolderFilter === ALL_FOLDERS || item.folderId === activeFolderFilter)
        ))?.id ?? null);
      }
      if (fileForm?.id === file.id) setFileForm(null);
      setLibraryError(null);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "לא ניתן למחוק את הקובץ.");
    } finally {
      setLibrarySaving(false);
    }
  };

  const selectSheetSection = (section: SheetSection) => {
    setActiveSheetSection(section);
    setActiveFolderFilter(ALL_FOLDERS);
    setSelectedSheetId(libraryFiles.find((file) => file.section === section)?.id ?? null);
    setFolderForm(null);
    setFileForm(null);
  };

  const selectFolder = (folderId: string) => {
    setActiveFolderFilter(folderId);
    const nextFile = libraryFiles.find((file) => (
      file.section === activeSheetSection
      && (folderId === ALL_FOLDERS || file.folderId === folderId)
    ));
    setSelectedSheetId(nextFile?.id ?? null);
    setFileForm(null);
  };

  const selectSheetFile = (fileId: string) => {
    setSelectedSheetId(fileId);
    if (!window.matchMedia("(max-width: 980px)").matches) return;

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        sheetFrameRef.current?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          block: "start",
        });
      });
    });
  };

  const sectionFolders = libraryFolders.filter((folder) => folder.section === activeSheetSection);
  const visibleSheetFiles = libraryFiles.filter((file) => (
    file.section === activeSheetSection
    && (activeFolderFilter === ALL_FOLDERS || file.folderId === activeFolderFilter)
  ));
  const activeSheetFile = libraryFiles.find((file) => file.id === selectedSheetId) ?? null;
  const activeSheetLabel = activeSheetSection === "warmup" ? "חימום" : "תרגול";
  const activeFolder = libraryFolders.find((folder) => folder.id === activeFolderFilter) ?? null;
  const activeFolderLabel = activeFolderFilter === ALL_FOLDERS
    ? activeSheetLabel
    : activeFolder?.name ?? "תיקייה";
  const editingFolder = folderForm?.id
    ? libraryFolders.find((folder) => folder.id === folderForm.id) ?? null
    : null;
  const notesStatusLabel = notesStatus === "loading"
    ? "טוען שיעורים…"
    : notesStatus === "saving"
      ? "שומר שינויים…"
      : notesStatus === "error"
        ? "השמירה נכשלה"
        : "נשמר אוטומטית";

  const navItems: Array<{ id: ViewName; label: string; icon: string }> = [
    { id: "metronome", label: "מטרונום", icon: "◉" },
    { id: "notes", label: "שיעורים", icon: "≡" },
    { id: "sheet", label: "תווים", icon: "♬" },
    { id: "projects", label: "פרויקטים", icon: "▦" },
  ];

  return (
    <main className="studio-shell">
      <div className="studio-layout">
        <aside className="studio-sidebar">
          <div className="brand-block">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
            <div><b>TEMPO</b><small>סביבת תרגול</small></div>
          </div>

          <nav className="side-nav" aria-label="ניווט ראשי">
            {navItems.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`nav-button ${activeView === item.id ? "active" : ""}`}
                onClick={() => {
                  setActiveView(item.id);
                  if (item.id !== "sheet") setIsSheetExpanded(false);
                }}
                aria-current={activeView === item.id ? "page" : undefined}
              >
                <span className="nav-icon" aria-hidden="true">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </button>
            ))}
          </nav>

          <p className="sidebar-tip">מקש רווח מפעיל ועוצר את המטרונום</p>
        </aside>

        <div className="studio-content">
          {activeView === "metronome" && (
            <section className="view-section metronome-view" aria-labelledby="metronome-title">
              <header className="page-heading">
                <div><p>תרגול בקצב שלך</p><h1 id="metronome-title">מטרונום</h1></div>
                <span className={`playing-status ${isPlaying ? "active" : ""}`} role="status" aria-live="polite">
                  <i />{isPlaying ? "פועל" : "מוכן"}
                </span>
              </header>

              <div className="metronome-grid">
                <div className="control-card">
                  <div className="control-section">
                    <label htmlFor="bpm-main">מהירות</label>
                    <div className="tempo-stepper" dir="ltr">
                      <button type="button" onClick={() => updateBpm(bpm - 1)} aria-label="הפחתת BPM">−</button>
                      <div className="tempo-input-wrap">
                        <input
                          id="bpm-main"
                          type="number"
                          inputMode="numeric"
                          min={MIN_BPM}
                          max={MAX_BPM}
                          value={bpmInput}
                          onChange={(event) => handleBpmInput(event.target.value)}
                          onBlur={commitBpmInput}
                          onFocus={(event) => event.currentTarget.select()}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                          }}
                          aria-label="מהירות המטרונום ב־BPM"
                        />
                        <span>BPM</span>
                      </div>
                      <button type="button" onClick={() => updateBpm(bpm + 1)} aria-label="הוספת BPM">+</button>
                    </div>
                    <div className="tempo-presets" dir="ltr" role="group" aria-label="מהירויות מוכנות">
                      {BPM_PRESETS.map((preset) => (
                        <button
                          type="button"
                          key={preset}
                          className={bpm === preset ? "active" : ""}
                          onClick={() => updateBpm(preset)}
                          aria-pressed={bpm === preset}
                        >
                          {preset} BPM
                        </button>
                      ))}
                    </div>
                    <input
                      className="tempo-range"
                      type="range"
                      dir="ltr"
                      min={MIN_BPM}
                      max={MAX_BPM}
                      value={bpm}
                      onChange={(event) => updateBpm(Number(event.target.value))}
                      aria-label="שינוי מהירות המטרונום"
                      aria-valuetext={`${bpm} פעימות בדקה`}
                      style={{ "--range-progress": `${((bpm - MIN_BPM) / (MAX_BPM - MIN_BPM)) * 100}%` } as React.CSSProperties}
                    />
                    <div className="range-ends" dir="ltr"><span>{MIN_BPM}</span><span>{MAX_BPM}</span></div>
                  </div>

                  <button
                    type="button"
                    className={`primary-action quick-start ${isPlaying ? "stop" : ""}`}
                    onClick={toggleMetronome}
                    aria-label={isPlaying ? "עצירת המטרונום" : "הפעלת המטרונום"}
                    aria-pressed={isPlaying}
                  >
                    <span className={isPlaying ? "mini-pause" : "mini-play"} aria-hidden="true" />
                    {isPlaying ? "עצירה" : "התחלה"}
                  </button>

                  <fieldset className="meter-section">
                    <legend>משקל</legend>
                    <div className="signature-builder">
                      <div className="signature-row">
                        <span>פעימות בתיבה</span>
                        <div className="option-scroller">
                          <div className="meter-segments beat-options" dir="ltr">
                            {METER_OPTIONS.map((value) => (
                              <button
                                type="button"
                                key={value}
                                className={beatsPerBar === value ? "selected" : ""}
                                onClick={() => updateMeter(value)}
                                aria-pressed={beatsPerBar === value}
                              >
                                {value}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="signature-row">
                        <span>יחידת פעימה</span>
                        <div className="option-scroller">
                          <div className="meter-segments unit-options" dir="ltr">
                            {BEAT_UNIT_OPTIONS.map((value) => (
                              <button
                                type="button"
                                key={value}
                                className={beatUnit === value ? "selected" : ""}
                                onClick={() => setBeatUnit(value)}
                                aria-pressed={beatUnit === value}
                              >
                                {value}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </fieldset>

                </div>

                <div className="visual-card">
                  <div className="full-beat-circle">
                    <BeatVisual beatsPerBar={beatsPerBar} currentBeat={currentBeat} isPlaying={isPlaying} />
                    <button
                      type="button"
                      className="circle-control"
                      onClick={toggleMetronome}
                      aria-label={isPlaying ? "עצירת המטרונום" : "הפעלת המטרונום"}
                      aria-pressed={isPlaying}
                    >
                      <span className={isPlaying ? "pause-symbol" : "play-symbol"} aria-hidden="true" />
                    </button>
                  </div>
                  <p dir={isPlaying && currentBeat !== null ? "rtl" : "ltr"}>
                    {isPlaying && currentBeat !== null
                      ? `פעימה ${currentBeat + 1} מתוך ${beatsPerBar}`
                      : `${bpm} BPM · ${beatsPerBar}/${beatUnit}`}
                  </p>
                </div>
              </div>
            </section>
          )}

          {activeView === "notes" && (
            <section className="view-section notes-view" aria-labelledby="notes-title">
              <header className="page-heading">
                <div><p>יומן השיעורים</p><h1 id="notes-title">שיעורים</h1></div>
                <span className={`local-save-status ${notesStatus}`} role="status"><i />{notesStatusLabel}</span>
              </header>

              {notesError && (
                <div className="notes-alert" role="alert">
                  <span>{notesError}</span>
                  <button type="button" onClick={retryLessonNotes}>ניסיון נוסף</button>
                </div>
              )}

              <div className="notes-grid">
                <aside className="lesson-details-card">
                  <div className="lessons-panel-heading">
                    <div><span>השיעורים שלי</span><small>{formatLessonCount(lessonEntries.length)}</small></div>
                    <button type="button" onClick={() => void createNewLesson()} disabled={notesBusy}>＋ שיעור חדש</button>
                  </div>

                  <nav className="lesson-list" aria-label="בחירת שיעור" aria-busy={notesStatus === "loading"}>
                    {lessonEntries.map((lesson) => (
                      <button
                        type="button"
                        key={lesson.id}
                        className={`lesson-list-item ${lesson.id === activeLessonId ? "active" : ""}`}
                        onClick={() => selectLesson(lesson.id)}
                        aria-current={lesson.id === activeLessonId ? "page" : undefined}
                      >
                        <b><bdi>{lesson.title || "שיעור ללא שם"}</bdi></b>
                        <small>{formatLessonDate(lesson.lessonDate)}</small>
                      </button>
                    ))}
                    {notesStatus !== "loading" && lessonEntries.length === 0 && (
                      <p className="lesson-list-empty">אין עדיין שיעורים. לחצו על „שיעור חדש”.</p>
                    )}
                  </nav>

                  {activeLesson && (
                    <div className="lesson-fields">
                      <span className="card-kicker">פרטי השיעור</span>
                      <label htmlFor="lesson-title">נושא</label>
                      <input
                        id="lesson-title"
                        type="text"
                        dir="auto"
                        maxLength={120}
                        value={activeLesson.title}
                        onChange={(event) => updateActiveLesson({ title: event.target.value })}
                        onBlur={() => void flushLessonSave(activeLesson.id)}
                        placeholder="לדוגמה: עבודה על קצב"
                        disabled={notesBusy}
                      />
                      <label htmlFor="lesson-date">תאריך</label>
                      <input
                        id="lesson-date"
                        type="date"
                        dir="ltr"
                        value={activeLesson.lessonDate}
                        onChange={(event) => updateActiveLesson({ lessonDate: event.target.value })}
                        onBlur={() => void flushLessonSave(activeLesson.id)}
                        disabled={notesBusy}
                      />
                      <button type="button" className="delete-lesson-button" onClick={() => void removeActiveLesson()} disabled={notesBusy}>מחיקת השיעור</button>
                    </div>
                  )}
                </aside>

                <article className="notes-paper">
                  {activeLesson ? (
                    <>
                      <div className="paper-heading">
                        <div><span>הערות השיעור</span><h2><bdi>{activeLesson.title || "שיעור ללא שם"}</bdi></h2></div>
                        {activeLesson.lessonDate && <time>{formatLessonDate(activeLesson.lessonDate)}</time>}
                      </div>
                      <RichNotesEditor
                        key={activeLesson.id}
                        initialHtml={activeLesson.bodyHtml}
                        onChange={(bodyHtml) => updateActiveLesson({ bodyHtml })}
                        onCommit={() => void flushLessonSave(activeLesson.id)}
                        disabled={notesBusy}
                      />
                    </>
                  ) : (
                    <div className="notes-empty-state">
                      <h2>בחרו שיעור לעריכה</h2>
                      <p>אפשר לפתוח שיעור קיים או ליצור שיעור חדש.</p>
                      <button type="button" onClick={() => void createNewLesson()} disabled={notesBusy}>שיעור חדש</button>
                    </div>
                  )}
                </article>
              </div>
            </section>
          )}

          {activeView === "sheet" && (
            <section className="view-section sheet-view" aria-labelledby="sheet-title">
              <header className="page-heading sheet-heading">
                <div><p>תרגול מול הדף</p><h1 id="sheet-title">תווים</h1></div>
                <div className="sheet-heading-actions">
                  <button
                    type="button"
                    className="folder-create-button"
                    onClick={() => setFolderForm({ mode: "create", name: "", section: activeSheetSection })}
                    disabled={librarySaving}
                  >
                    תיקייה חדשה
                  </button>
                  <button
                    type="button"
                    className="upload-button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={librarySaving}
                  >
                    <span aria-hidden="true">＋</span>{librarySaving ? "מעלה…" : "הוספת קבצים"}
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  id="sheet-file-input"
                  className="file-input"
                  type="file"
                  accept=".pdf,image/png,image/jpeg,image/webp"
                  multiple
                  disabled={librarySaving}
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = "";
                    void handleSheetFiles(files, activeSheetSection);
                  }}
                />
              </header>

              {libraryError && <p className="library-alert" role="alert">{libraryError}</p>}

              <div className={`sheet-layout ${activeSheetFile ? "has-file" : "no-file"}`}>
                <aside className="library-panel" aria-label="קבצי תווים לפי סוג תרגול" aria-busy={libraryLoading || librarySaving}>
                  <div className="library-section-switch" role="group" aria-label="סוג התרגול">
                    {(["warmup", "practice"] as const).map((section) => {
                      const label = section === "warmup" ? "חימום" : "תרגול";
                      const count = libraryFiles.filter((file) => file.section === section).length;
                      return (
                        <button
                          type="button"
                          key={section}
                          className={activeSheetSection === section ? "active" : ""}
                          onClick={() => selectSheetSection(section)}
                          aria-pressed={activeSheetSection === section}
                        >
                          <b>{label}</b>
                          <small>{formatFileCount(count)}</small>
                        </button>
                      );
                    })}
                  </div>

                  {folderForm && (
                    <form
                      className="folder-editor"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveFolder();
                      }}
                    >
                      <div className="editor-heading">
                        <b>{folderForm.mode === "create" ? "תיקייה חדשה" : "עריכת תיקייה"}</b>
                        <button type="button" onClick={() => setFolderForm(null)} aria-label="ביטול עריכת התיקייה">×</button>
                      </div>
                      <label htmlFor="folder-name">שם התיקייה</label>
                      <input
                        id="folder-name"
                        dir="auto"
                        maxLength={80}
                        value={folderForm.name}
                        onChange={(event) => setFolderForm((current) => current ? { ...current, name: event.target.value } : current)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setFolderForm(null);
                        }}
                        placeholder="לדוגמה: סולמות"
                      />
                      <label htmlFor="folder-section">שייך אל</label>
                      <select
                        id="folder-section"
                        value={folderForm.section}
                        onChange={(event) => setFolderForm((current) => current ? { ...current, section: event.target.value as SheetSection } : current)}
                      >
                        <option value="warmup">חימום</option>
                        <option value="practice">תרגול</option>
                      </select>
                      <div className="editor-actions">
                        <button type="submit" className="save-edit" disabled={librarySaving}>שמירה</button>
                        <button type="button" onClick={() => setFolderForm(null)}>ביטול</button>
                        {editingFolder && (
                          <button type="button" className="danger-edit" onClick={() => void removeFolder(editingFolder)}>מחיקת התיקייה</button>
                        )}
                      </div>
                    </form>
                  )}

                  {sectionFolders.length > 0 && <nav className="folder-list" aria-label={`תיקיות ${activeSheetLabel}`}>
                    {sectionFolders.map((folder) => {
                      const count = libraryFiles.filter((file) => file.folderId === folder.id).length;
                      const isActive = activeFolderFilter === folder.id;
                      return (
                        <div key={folder.id} className={`folder-row ${isActive ? "active" : ""}`}>
                          <button
                            type="button"
                            className="folder-row-main"
                            onClick={() => selectFolder(folder.id)}
                            aria-current={isActive ? "page" : undefined}
                          >
                            <span className="folder-mark" aria-hidden="true" />
                            <span><b><bdi>{folder.name}</bdi></b><small>{formatFileCount(count)}</small></span>
                          </button>
                          <button
                            type="button"
                            className="item-edit-button"
                            onClick={() => setFolderForm({ mode: "edit", id: folder.id, name: folder.name, section: folder.section })}
                            aria-label={`עריכת התיקייה ${folder.name}`}
                          >
                            עריכה
                          </button>
                        </div>
                      );
                    })}
                  </nav>}

                  <div className="library-files-heading">
                    <h3>קבצים ב־<bdi>{activeFolderLabel}</bdi></h3>
                    <span>{formatFileCount(visibleSheetFiles.length)}</span>
                  </div>

                  {libraryLoading && <p className="library-status" role="status">טוען את הקבצים…</p>}
                  {!libraryLoading && visibleSheetFiles.length === 0 && (
                    <div className="library-empty">
                      <p>אין עדיין קבצים ב־<bdi>{activeFolderLabel}</bdi>.</p>
                      <button type="button" onClick={() => fileInputRef.current?.click()}>הוספת קבצים</button>
                    </div>
                  )}

                  <div className="library-list" aria-label={`קבצים ב־${activeFolderLabel}`}>
                    {visibleSheetFiles.map((file) => {
                      const isSelected = file.id === selectedSheetId;
                      const isPdf = file.contentType === "application/pdf";
                      return (
                        <article key={file.id} className={`library-file ${isSelected ? "active" : ""}`}>
                          <div className="library-file-row">
                            <button
                              type="button"
                              className="library-file-select"
                              onClick={() => selectSheetFile(file.id)}
                              aria-current={isSelected ? "true" : undefined}
                            >
                              <span className="file-kind" aria-hidden="true">{isPdf ? "PDF" : "IMG"}</span>
                              <span>
                                <b><bdi>{file.name}</bdi></b>
                                <small><span dir="ltr">{formatFileSize(file.size)}</span> · {new Date(file.createdAt).toLocaleDateString("he-IL")}</small>
                              </span>
                            </button>
                            <button
                              type="button"
                              className="item-edit-button"
                              onClick={() => setFileForm({ id: file.id, name: file.name, section: file.section, folderId: file.folderId ?? "" })}
                              aria-label={`עריכת ${file.name}`}
                            >
                              עריכה
                            </button>
                          </div>

                          {fileForm?.id === file.id && (
                            <form
                              className="file-editor"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void saveFile();
                              }}
                            >
                              <label htmlFor={`file-name-${file.id}`}>שם הקובץ</label>
                              <input
                                id={`file-name-${file.id}`}
                                dir="auto"
                                maxLength={180}
                                value={fileForm.name}
                                onChange={(event) => setFileForm((current) => current ? { ...current, name: event.target.value } : current)}
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") setFileForm(null);
                                }}
                              />
                              <div className="file-location-fields">
                                <label>
                                  <span>אזור</span>
                                  <select
                                    value={fileForm.section}
                                    onChange={(event) => setFileForm((current) => current ? {
                                      ...current,
                                      section: event.target.value as SheetSection,
                                      folderId: "",
                                    } : current)}
                                  >
                                    <option value="warmup">חימום</option>
                                    <option value="practice">תרגול</option>
                                  </select>
                                </label>
                                <label>
                                  <span>תיקייה</span>
                                  <select
                                    value={fileForm.folderId}
                                    onChange={(event) => setFileForm((current) => current ? { ...current, folderId: event.target.value } : current)}
                                  >
                                    <option value="">כללי</option>
                                    {libraryFolders.filter((folder) => folder.section === fileForm.section).map((folder) => (
                                      <option key={folder.id} value={folder.id}>{folder.name}</option>
                                    ))}
                                  </select>
                                </label>
                              </div>
                              <div className="editor-actions">
                                <button type="submit" className="save-edit" disabled={librarySaving}>שמירה</button>
                                <button type="button" onClick={() => setFileForm(null)}>ביטול</button>
                                <button type="button" className="danger-edit" onClick={() => void removeSheetFile(file)}>מחיקת הקובץ</button>
                              </div>
                            </form>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </aside>

                <div ref={sheetFrameRef} className={`sheet-frame ${isSheetExpanded ? "expanded" : ""}`}>
                  <div className="sheet-toolbar">
                    <span><bdi>{activeSheetFile?.name ?? `עדיין לא נבחר קובץ עבור ${activeSheetLabel}`}</bdi></span>
                    {activeSheetFile && (
                      <div className="sheet-toolbar-actions">
                        <button
                          type="button"
                          className="sheet-expand-button"
                          onClick={() => setIsSheetExpanded((current) => !current)}
                          aria-pressed={isSheetExpanded}
                          title={isSheetExpanded ? "חזרה לתצוגה הרגילה" : "הגדלת התווים על המסך"}
                        >
                          <span aria-hidden="true">{isSheetExpanded ? "⊟" : "⛶"}</span>
                          {isSheetExpanded ? "חזרה" : "הגדלה"}
                        </button>
                        <a href={activeSheetFile.url} target="_blank" rel="noreferrer">פתיחה בחלון חדש</a>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedSheetId(null);
                            setIsSheetExpanded(false);
                          }}
                        >
                          סגירה
                        </button>
                      </div>
                    )}
                  </div>

                  <div className={`sheet-canvas ${activeSheetFile?.contentType === "application/pdf" ? "has-mobile-pdf-link" : ""}`}>
                    {!activeSheetFile && (
                      <div className="sheet-empty">
                        <div className="staff-preview" aria-hidden="true"><span>𝄞</span><i /><i /><i /></div>
                        <h2>תווים עבור {activeSheetLabel}</h2>
                        <p>בחרו קובץ מהרשימה או הוסיפו כמה קובצי PDF ותמונות יחד.</p>
                        <button type="button" className="secondary-upload" onClick={() => fileInputRef.current?.click()}>הוספת קבצים</button>
                      </div>
                    )}
                    {activeSheetFile?.contentType.startsWith("image/") && <img src={activeSheetFile.url} alt={`תווים מתוך ${activeSheetFile.name}`} />}
                    {activeSheetFile?.contentType === "application/pdf" && (
                      <>
                        <a className="mobile-pdf-open" href={activeSheetFile.url} target="_blank" rel="noreferrer">
                          פתיחת PDF במסך מלא
                        </a>
                        <object data={activeSheetFile.url} type="application/pdf" aria-label={`תווים מתוך ${activeSheetFile.name}`}>
                          <p>לא ניתן להציג את הקובץ כאן. <a href={activeSheetFile.url} target="_blank" rel="noreferrer">פתיחת ה־PDF</a></p>
                        </object>
                      </>
                    )}
                  </div>
                </div>

                <aside
                  ref={floatingMetronomeRef}
                  className={`floating-metronome ${isDraggingMetronome ? "dragging" : ""} ${isFloatingMetronomeMinimized ? "minimized" : ""}`}
                  aria-label={`מטרונום צף, ${bpm} BPM`}
                  style={floatingMetronomePosition ? {
                    insetInlineStart: `${floatingMetronomePosition.inlineStart}px`,
                    insetInlineEnd: "auto",
                    insetBlockStart: `${floatingMetronomePosition.blockStart}px`,
                    insetBlockEnd: "auto",
                  } : undefined}
                >
                  <div className="floating-metronome-header">
                    <button
                      type="button"
                      className="metronome-drag-handle"
                      aria-label="הזזת המטרונום הצף. אפשר לגרור או להשתמש במקשי החיצים"
                      title="גרירה להזזת המטרונום"
                      onPointerDown={beginMetronomeDrag}
                      onPointerMove={moveMetronomeDrag}
                      onPointerUp={endMetronomeDrag}
                      onPointerCancel={endMetronomeDrag}
                      onLostPointerCapture={endMetronomeDrag}
                      onKeyDown={(event) => {
                        const step = event.shiftKey ? 32 : 12;
                        if (event.key === "ArrowLeft") moveFloatingMetronomeBy(-step, 0);
                        else if (event.key === "ArrowRight") moveFloatingMetronomeBy(step, 0);
                        else if (event.key === "ArrowUp") moveFloatingMetronomeBy(0, -step);
                        else if (event.key === "ArrowDown") moveFloatingMetronomeBy(0, step);
                        else return;
                        event.preventDefault();
                      }}
                    >
                      <span aria-hidden="true">⠿</span>
                      <b dir="ltr">{bpm} BPM</b>
                    </button>
                    <button
                      type="button"
                      className="metronome-size-toggle"
                      onClick={() => setIsFloatingMetronomeMinimized((current) => !current)}
                      aria-label={isFloatingMetronomeMinimized ? "הגדלת חלונית המטרונום" : "מזעור חלונית המטרונום"}
                      aria-pressed={isFloatingMetronomeMinimized}
                      title={isFloatingMetronomeMinimized ? "הגדלה" : "מזעור"}
                    >
                      <span aria-hidden="true">{isFloatingMetronomeMinimized ? "＋" : "−"}</span>
                    </button>
                  </div>
                  {!isFloatingMetronomeMinimized && (
                    <div className="floating-tempo-presets" dir="ltr" role="group" aria-label="קיצורי מהירות למטרונום הצף">
                      {BPM_PRESETS.map((preset) => (
                        <button
                          type="button"
                          key={preset}
                          className={bpm === preset ? "active" : ""}
                          onClick={() => updateBpm(preset)}
                          aria-label={`מעבר ל־${preset} BPM`}
                          aria-pressed={bpm === preset}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    className="mini-circle-button"
                    onClick={toggleMetronome}
                    aria-label={isPlaying ? `עצירת המטרונום, ${bpm} BPM` : `הפעלת המטרונום, ${bpm} BPM`}
                    aria-pressed={isPlaying}
                  >
                    <BeatVisual beatsPerBar={beatsPerBar} currentBeat={currentBeat} isPlaying={isPlaying} compact />
                    <span className={isPlaying ? "mini-center playing" : "mini-center"} aria-hidden="true" />
                  </button>
                </aside>
              </div>
            </section>
          )}

          {activeView === "projects" && (
            <ProjectsView
              activeProject={activeProject}
              onOpenProject={setActiveProject}
              onCloseProject={() => setActiveProject(null)}
            />
          )}
        </div>
      </div>
    </main>
  );
}
