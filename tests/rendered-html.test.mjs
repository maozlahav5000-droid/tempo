import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  chooseInitialLibrarySelection,
  LIBRARY_SECTION_ORDER,
} from "../app/library-selection.mjs";
import { secondsPerBeat } from "../app/metronome-timing.mjs";

const hebrewRtlDocument =
  /<html(?=[^>]*\blang=["']he["'])(?=[^>]*\bdir=["']rtl["'])[^>]*>/i;

function inspectPcmWav(buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");

  let format;
  let pcmData;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === "data") {
      pcmData = buffer.subarray(chunkStart, chunkStart + chunkSize);
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  assert.ok(format, "WAV fmt chunk is missing");
  assert.ok(pcmData, "WAV data chunk is missing");
  let peak = 0;
  let sampleSum = 0;
  const tailSampleCount = Math.round(format.sampleRate * format.channels * 0.02);
  let tailSquareSum = 0;
  let sampleIndex = 0;
  const totalSamples = pcmData.length / 2;
  for (let offset = 0; offset + 2 <= pcmData.length; offset += 2) {
    const value = pcmData.readInt16LE(offset) / 32768;
    peak = Math.max(peak, Math.abs(value));
    sampleSum += value;
    if (sampleIndex >= totalSamples - tailSampleCount) tailSquareSum += value * value;
    sampleIndex += 1;
  }
  const bytesPerSecond = format.sampleRate * format.channels * (format.bitsPerSample / 8);
  return {
    ...format,
    duration: pcmData.length / bytesPerSecond,
    peak,
    dc: sampleSum / totalSamples,
    tailRms: Math.sqrt(tailSquareSum / tailSampleCount),
  };
}

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders TEMPO as a Hebrew RTL document", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, hebrewRtlDocument);
  assert.match(html, /<title>TEMPO<\/title>/i);
  assert.match(html, /<b>TEMPO<\/b>/);
  assert.doesNotMatch(
    html,
    /codex-preview|Your site is taking shape|Building your site|react-loading-skeleton/i,
  );
});

test("server-renders the current metronome controls", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /<h1 id="metronome-title">מטרונום<\/h1>/);
  assert.match(
    html,
    /<input id="bpm-main"[^>]*\bmin="40"[^>]*\bmax="240"[^>]*\bvalue="60"\/>/,
  );
  assert.match(html, /aria-label="מהירות המטרונום ב־BPM"/);
  assert.match(html, /<legend>משקל<\/legend>/);
  assert.match(html, /id="beat-unit-label">יחידת פעימה<\/span>/);
  assert.match(html, /id="beat-unit-help"[^>]*>רבע — טיקטוק אחד בכל פעימה<\/p>/);
  assert.match(html, /60 BPM · 4\/4/);
});

test("beat unit changes the metronome interval", () => {
  const bpm = 60;
  const expectedIntervals = [
    [2, 2],
    [4, 1],
    [8, 0.5],
    [16, 0.25],
    [1, 4],
  ];

  for (const [beatUnit, expectedSeconds] of expectedIntervals) {
    assert.equal(
      secondsPerBeat(bpm, beatUnit),
      expectedSeconds,
      `${beatUnit} as the beat unit should produce a ${expectedSeconds}s interval at ${bpm} BPM`,
    );
  }
});

test("the scheduler reads the selected beat unit and resyncs while playing", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /secondsPerBeat\(bpmRef\.current, beatUnitRef\.current\)/);
  assert.match(page, /beatUnitRef\.current = value;/);
  assert.match(page, /nextNoteTimeRef\.current = context\.currentTime \+ 0\.05;/);
});

test("uses the smooth Hebrew UI typeface instead of the old mono display font", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(layout, /import \{ Heebo \} from "next\/font\/google"/);
  assert.doesNotMatch(layout, /Space_Mono|Assistant/);
  assert.match(
    css,
    /\.tempo-input-wrap input\s*\{[^}]*font-family:\s*var\(--font-heebo\)[^}]*font-size:\s*clamp\(3rem,\s*6vw,\s*4\.4rem\)[^}]*font-weight:\s*600/,
  );
  assert.doesNotMatch(css, /--font-space-mono|--font-assistant/);
});

test("keeps lesson-note bullets visible after the Tailwind list reset", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(
    css,
    /\.rich-notes-editor ul\s*\{[^}]*\blist-style-type:\s*disc\s*;/,
  );
  assert.match(
    css,
    /\.rich-notes-editor li::marker\s*\{[^}]*\bcolor:\s*#16866d\s*;/i,
  );
});

test("ships the reference metronome sounds as strong mono PCM samples", async () => {
  const sampleUrls = [
    new URL("../public/audio/metronome-accent.wav", import.meta.url),
    new URL("../public/audio/metronome-beat.wav", import.meta.url),
  ];

  for (const sampleUrl of sampleUrls) {
    const sample = inspectPcmWav(await readFile(sampleUrl));
    assert.equal(sample.audioFormat, 1);
    assert.equal(sample.channels, 1);
    assert.equal(sample.sampleRate, 44_100);
    assert.equal(sample.bitsPerSample, 16);
    assert.ok(sample.duration >= 0.23 && sample.duration <= 0.25);
    assert.ok(sample.peak >= 0.68 && sample.peak <= 0.78);
    assert.ok(Math.abs(sample.dc) < 0.001);
    assert.ok(sample.tailRms < 0.002);
  }
});

test("ships both violin projects and the promoted Lomedet Laof player", async () => {
  const projectsView = await readFile(
    new URL("../app/components/ProjectsView.tsx", import.meta.url),
    "utf8",
  );
  const projectIds = [...projectsView.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(projectIds, ["shkiot-adumot", "lomedet-laof"]);
  assert.match(projectsView, /title:\s*"שקיעות אדומות"/);
  assert.match(projectsView, /title:\s*"לומדת לעוף"/);
  assert.match(projectsView, /path:\s*"\/projects\/lomedet-laof\/index\.html"/);
  assert.match(projectsView, /meta:\s*\["לה מז׳ור",\s*"12 תיבות · 2 גבהים"\]/);

  const publicPlayer = await readFile(
    new URL("../public/projects/lomedet-laof/index.html", import.meta.url),
    "utf8",
  );
  const builtPlayer = await readFile(
    new URL("../dist/client/projects/lomedet-laof/index.html", import.meta.url),
    "utf8",
  );
  const publicExperimentPlayer = await readFile(
    new URL("../public/projects/lomedet-laof-experiment/index.html", import.meta.url),
    "utf8",
  );
  const builtExperimentPlayer = await readFile(
    new URL("../dist/client/projects/lomedet-laof-experiment/index.html", import.meta.url),
    "utf8",
  );
  const publicScore = await readFile(
    new URL("../public/projects/lomedet-laof/lomedet-laof-two-registers.pdf", import.meta.url),
  );
  const builtScore = await readFile(
    new URL("../dist/client/projects/lomedet-laof/lomedet-laof-two-registers.pdf", import.meta.url),
  );
  const publicLicense = await readFile(
    new URL("../public/projects/lomedet-laof/THIRD-PARTY-LICENSE-VSCO2CE.txt", import.meta.url),
    "utf8",
  );
  const builtLicense = await readFile(
    new URL("../dist/client/projects/lomedet-laof/THIRD-PARTY-LICENSE-VSCO2CE.txt", import.meta.url),
    "utf8",
  );
  const builtAssetsIgnore = await readFile(
    new URL("../dist/client/.assetsignore", import.meta.url),
    "utf8",
  );

  assert.match(publicPlayer, hebrewRtlDocument);
  assert.match(publicPlayer, /<title>לומדת לעוף — פזמון לכינור<\/title>/);
  assert.match(publicPlayer, /לה מז׳ור/);
  assert.match(publicPlayer, /id="chorus-data" type="application\/json"/);
  assert.match(publicPlayer, /id="violin-samples" type="application\/json"/);
  assert.match(publicPlayer, /id="register"/);
  assert.match(publicPlayer, /id="timbre"/);
  assert.match(publicPlayer, /href="lomedet-laof-two-registers\.pdf" download/);
  assert.doesNotMatch(publicPlayer, /הפרויקט המקורי נשאר ללא שינוי/);
  assert.doesNotMatch(publicPlayer, /<h1[^>]*>[^<]*ניסוי/);
  assert.equal(builtPlayer, publicPlayer);

  const extractEmbeddedJson = (html, id) => {
    const match = html.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)<\\/script>`));
    assert.ok(match, `missing embedded JSON: ${id}`);
    return JSON.parse(match[1]);
  };
  const chorusData = extractEmbeddedJson(publicPlayer, "chorus-data");
  const violinSamples = extractEmbeddedJson(publicPlayer, "violin-samples");
  const endingPitches = chorusData.events
    .filter((event) => event.kind === "note" && !event.tieStop && event.startQ >= 40)
    .map((event) => event.midi);
  const finalRest = chorusData.events.filter((event) => event.kind === "rest").at(-1);

  assert.equal(chorusData.tempo.bpm, 120);
  assert.equal(chorusData.measures.length, 12);
  assert.equal(chorusData.events.length, 49);
  assert.equal(chorusData.events.filter((event) => event.kind === "note").length, 36);
  assert.deepEqual(endingPitches, [57, 59, 60]);
  assert.equal(finalRest.startQ, 44);
  assert.equal(finalRest.durationQ, 4);
  assert.equal(violinSamples.length, 6);

  assert.equal(publicScore.toString("ascii", 0, 4), "%PDF");
  assert.deepEqual(builtScore, publicScore);
  assert.equal(builtLicense, publicLicense);

  assert.match(publicExperimentPlayer, /<title>לומדת לעוף — מעבר לגרסה המעודכנת<\/title>/);
  assert.match(publicExperimentPlayer, /\.\.\/lomedet-laof\/index\.html/);
  assert.equal(builtExperimentPlayer, publicExperimentPlayer);
  assert.doesNotMatch(builtAssetsIgnore, /lomedet-laof-experiment/);
});

test("labels the song area consistently and keeps the internal project routes stable", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const projectsView = await readFile(
    new URL("../app/components/ProjectsView.tsx", import.meta.url),
    "utf8",
  );

  assert.match(page, /\{ id: "projects", label: "שירים", icon: "▦" \}/);
  assert.match(projectsView, /activeProjectData\?\.title \?\? "שירים"/);
  assert.match(projectsView, /כל השירים/);
  assert.match(projectsView, /\{PROJECTS\.length\} שירים/);
  assert.match(projectsView, /פתיחת השיר/);
  assert.doesNotMatch(projectsView, />פרויקטים</);
  assert.match(projectsView, /path: "\/projects\/shkiot-adumot\/index\.html"/);
  assert.match(projectsView, /path: "\/projects\/lomedet-laof\/index\.html"/);
});

test("defines three complete sheet-library categories across UI, API, and storage", async () => {
  const [page, css, library, schema, libraryRoute, foldersRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../db/library.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/library/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/folders/route.ts", import.meta.url), "utf8"),
  ]);

  assert.deepEqual(LIBRARY_SECTION_ORDER, ["warmup", "practice", "personal"]);
  assert.match(page, /\{ id: "warmup", label: "חימום" \}/);
  assert.match(page, /\{ id: "practice", label: "תרגול" \}/);
  assert.match(page, /\{ id: "personal", label: "פרויקטים אישיים" \}/);
  assert.match(page, /SHEET_SECTIONS\.map\(\(section\) =>/);
  assert.match(css, /\.library-section-switch\s*\{[^}]*grid-template-columns:\s*repeat\(3,/);
  assert.match(css, /\.library-section-switch button b\s*\{[^}]*white-space:\s*normal/);

  assert.match(library, /LIBRARY_SECTIONS = \["warmup", "practice", "personal"\] as const/);
  assert.match(library, /CHECK \(section IN \('warmup', 'practice', 'personal'\)\)/);
  assert.match(schema, /enum: \["warmup", "practice", "personal"\]/);
  assert.match(libraryRoute, /\bisLibrarySection\b/);
  assert.match(foldersRoute, /\bisLibrarySection\b/);
  assert.doesNotMatch(libraryRoute, /value === "warmup" \|\| value === "practice"/);
  assert.doesNotMatch(foldersRoute, /value === "warmup" \|\| value === "practice"/);
});

test("initial sheet selection never crosses category boundaries", () => {
  assert.deepEqual(
    chooseInitialLibrarySelection(
      [
        { id: "warmup-file", section: "warmup" },
        { id: "personal-file", section: "personal" },
      ],
      [],
    ),
    { section: "warmup", fileId: "warmup-file" },
  );

  assert.deepEqual(
    chooseInitialLibrarySelection(
      [{ id: "personal-file", section: "personal" }],
      [],
    ),
    { section: "personal", fileId: "personal-file" },
  );

  assert.deepEqual(
    chooseInitialLibrarySelection(
      [{ id: "personal-file", section: "personal" }],
      [{ id: "empty-warmup", section: "warmup" }],
    ),
    { section: "warmup", fileId: null },
  );
});

test("routes project assets through the private-access worker", async () => {
  const wranglerConfig = JSON.parse(
    await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"),
  );
  assert.equal(wranglerConfig.assets.binding, "ASSETS");
  assert.deepEqual(wranglerConfig.assets.run_worker_first, ["/projects/*"]);

  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("project-access-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  let assetRequests = 0;
  const env = {
    TEMPO_ACCESS_TOKEN: "test-private-token",
    ASSETS: {
      fetch: async () => {
        assetRequests += 1;
        return new Response("protected project player", { status: 200 });
      },
    },
  };
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  };
  const url = "https://tempo.example.workers.dev/projects/lomedet-laof/index.html";

  const unauthenticated = await worker.fetch(new Request(url), env, ctx);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("cache-control"), "no-store");
  assert.equal(unauthenticated.headers.get("x-frame-options"), "DENY");
  assert.equal(assetRequests, 0);

  const authenticated = await worker.fetch(
    new Request(url, { headers: { cookie: "tempo_cloud_access=test-private-token" } }),
    env,
    ctx,
  );
  assert.equal(authenticated.status, 200);
  assert.equal(await authenticated.text(), "protected project player");
  assert.equal(assetRequests, 1);

  const missingAssets = await worker.fetch(
    new Request(url, { headers: { cookie: "tempo_cloud_access=test-private-token" } }),
    { TEMPO_ACCESS_TOKEN: "test-private-token" },
    ctx,
  );
  assert.equal(missingAssets.status, 503);
  assert.equal(missingAssets.headers.get("cache-control"), "no-store");
  assert.match(await missingAssets.text(), /השירות אינו זמין כרגע/);
});

test("gives shared users every visible feature behind their own access cookie", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("guest-access-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  let assetRequests = 0;
  const env = {
    TEMPO_ACCESS_TOKEN: "test-owner-token",
    TEMPO_GUEST_TOKEN: "test-guest-token",
    ASSETS: {
      fetch: async () => {
        assetRequests += 1;
        return new Response("private song asset", { status: 200 });
      },
    },
  };
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  };
  const origin = "https://tempo.example.workers.dev";

  const guestEntry = await worker.fetch(
    new Request(`${origin}/?view=metronome&access=test-guest-token`),
    env,
    ctx,
  );
  assert.equal(guestEntry.status, 302);
  assert.equal(guestEntry.headers.get("location"), "/?view=metronome");
  assert.match(guestEntry.headers.get("set-cookie") ?? "", /^tempo_guest_access=test-guest-token;/);
  assert.match(guestEntry.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(guestEntry.headers.get("set-cookie") ?? "", /Secure/);
  assert.match(guestEntry.headers.get("set-cookie") ?? "", /SameSite=Strict/);
  assert.equal(guestEntry.headers.get("cache-control"), "no-store");
  assert.equal(guestEntry.headers.get("referrer-policy"), "no-referrer");

  const guestHeaders = { cookie: "tempo_guest_access=test-guest-token" };
  const guestPage = await worker.fetch(
    new Request(`${origin}/`, { headers: { ...guestHeaders, accept: "text/html" } }),
    env,
    ctx,
  );
  assert.equal(guestPage.status, 200);
  const guestHtml = await guestPage.text();
  assert.match(guestHtml, /<h1 id="metronome-title">מטרונום<\/h1>/);
  for (const label of ["מטרונום", "שיעורים", "תווים", "שירים"]) {
    assert.match(guestHtml, new RegExp(`<span class="nav-label">${label}<\\/span>`));
  }
  assert.doesNotMatch(guestHtml, /מצב אורח/);

  const guestSession = await worker.fetch(
    new Request(`${origin}/api/session`, { headers: guestHeaders }),
    env,
    ctx,
  );
  assert.equal(guestSession.status, 200);
  assert.deepEqual(await guestSession.json(), {
    mode: "guest",
    privateContentAvailable: true,
  });

  const ownerSession = await worker.fetch(
    new Request(`${origin}/api/session`, {
      headers: { cookie: "tempo_cloud_access=test-owner-token" },
    }),
    env,
    ctx,
  );
  assert.equal(ownerSession.status, 200);
  assert.deepEqual(await ownerSession.json(), {
    mode: "owner",
    privateContentAvailable: true,
  });

  const guestProject = await worker.fetch(
    new Request(`${origin}/projects/lomedet-laof/index.html`, { headers: guestHeaders }),
    env,
    ctx,
  );
  assert.equal(guestProject.status, 200);
  assert.equal(await guestProject.text(), "private song asset");
  assert.equal(assetRequests, 1);

  const crossedCookies = [
    "tempo_cloud_access=test-guest-token",
    "tempo_guest_access=test-owner-token",
  ];
  for (const cookie of crossedCookies) {
    const response = await worker.fetch(
      new Request(`${origin}/api/session`, { headers: { cookie } }),
      env,
      ctx,
    );
    assert.equal(response.status, 401);
  }
});

test("shared UI is visually identical and scopes all persistent data", async () => {
  const [page, css, workerSource, schema, library, notes, libraryRoute, foldersRoute, notesRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/library.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/notes.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/library/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/folders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/notes/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /type AccessMode = "loading" \| "owner" \| "guest"/);
  assert.match(page, /fetch\("\/api\/session"/);
  assert.match(page, /accessMode === "owner" && !notes\.length && !legacyChecked/);
  assert.ok(
    (page.match(/if \(accessMode === "loading"\) return;/g) ?? []).length >= 3,
    "private loaders must wait for a verified owner or guest session",
  );
  for (const id of ["metronome", "notes", "sheet", "projects"]) {
    assert.match(page, new RegExp(`\\{ id: "${id}", label:`));
  }
  assert.doesNotMatch(page, /מצב אורח|guest-mode-notice|guest-nav/);
  assert.doesNotMatch(css, /guest-mode-notice|guest-nav/);

  assert.match(workerSource, /handlerHeaders\.set\("X-Tempo-Access-Mode", accessMode\)/);
  assert.match(workerSource, /!accessToken && !isLocalDevelopment/);
  assert.match(schema, /if \(accessMode === "owner" \|\| accessMode === "guest"\) return accessMode/);
  assert.match(schema, /guest_practice_folders/);
  assert.match(schema, /guest_practice_files/);
  assert.match(schema, /guest_lesson_notes/);
  assert.match(library, /guest\/practice-library\/\$\{id\}/);
  assert.match(notes, /guest_lesson_notes/);
  for (const route of [libraryRoute, foldersRoute, notesRoute]) {
    assert.match(route, /tempoAccessModeFromRequest\(request\)/);
  }
});
