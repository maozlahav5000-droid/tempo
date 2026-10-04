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
