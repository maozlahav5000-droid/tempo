import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(html, /60 BPM · 4\/4/);
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

test("ships both violin projects and the Lomedet Laof player", async () => {
  const projectsView = await readFile(
    new URL("../app/components/ProjectsView.tsx", import.meta.url),
    "utf8",
  );
  const projectIds = [...projectsView.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(projectIds, ["shkiot-adumot", "lomedet-laof"]);
  assert.match(projectsView, /title:\s*"שקיעות אדומות"/);
  assert.match(projectsView, /title:\s*"לומדת לעוף"/);
  assert.match(projectsView, /path:\s*"\/projects\/lomedet-laof\/index\.html"/);
  assert.match(projectsView, /meta:\s*\["לה מז׳ור",\s*"9 תיבות"\]/);

  const publicPlayer = await readFile(
    new URL("../public/projects/lomedet-laof/index.html", import.meta.url),
    "utf8",
  );
  const builtPlayer = await readFile(
    new URL("../dist/client/projects/lomedet-laof/index.html", import.meta.url),
    "utf8",
  );

  assert.match(publicPlayer, hebrewRtlDocument);
  assert.match(publicPlayer, /<title>לומדת לעוף — פזמון<\/title>/);
  assert.match(publicPlayer, /לה מז׳ור/);
  assert.match(publicPlayer, /id="chorus-data" type="application\/json"/);
  assert.equal(builtPlayer, publicPlayer);
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
  assert.match(await missingAssets.text(), /הפרויקט אינו זמין כרגע/);
});
