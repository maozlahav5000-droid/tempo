import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hebrewRtlDocument =
  /<html(?=[^>]*\blang=["']he["'])(?=[^>]*\bdir=["']rtl["'])[^>]*>/i;

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
