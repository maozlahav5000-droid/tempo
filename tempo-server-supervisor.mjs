import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { get as httpGet } from "node:http";
import { resolve } from "node:path";

const projectRoot = process.cwd();
const nodePath = process.execPath;
const wranglerPath = resolve(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const wranglerConfigPath = resolve(projectRoot, "dist", "server", "wrangler.json");
const statePath = resolve(projectRoot, ".wrangler", "state");
const logDirectory = resolve(projectRoot, ".tempo-server");
const outputLogPath = resolve(logDirectory, "server.log");
const errorLogPath = resolve(logDirectory, "server-error.log");
const supervisorLogPath = resolve(logDirectory, "supervisor.log");
const healthPaths = ["/", "/api/notes", "/api/library", "/api/folders"];

mkdirSync(logDirectory, { recursive: true });

if (!existsSync(wranglerPath)) throw new Error(`Wrangler was not found at ${wranglerPath}`);
if (!existsSync(wranglerConfigPath)) throw new Error(`TEMPO build was not found at ${wranglerConfigPath}`);

let activeChild = null;
let shuttingDown = false;
let healthCheckRunning = false;
let consecutiveHealthFailures = 0;

function log(message) {
  appendFileSync(supervisorLogPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function checkPath(pathname) {
  return new Promise((resolveCheck) => {
    const request = httpGet({
      hostname: "127.0.0.1",
      port: 3000,
      path: pathname,
      timeout: 5_000,
    }, (response) => {
      response.resume();
      resolveCheck(response.statusCode === 200);
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolveCheck(false));
  });
}

async function isHealthy() {
  for (const pathname of healthPaths) {
    if (!(await checkPath(pathname))) return false;
  }
  return true;
}

function stopProcessTree(processId) {
  if (!processId) return Promise.resolve();
  if (process.platform !== "win32") {
    try {
      activeChild?.kill("SIGTERM");
    } catch {
      // The process may already be gone.
    }
    return Promise.resolve();
  }

  return new Promise((resolveStop) => {
    const killer = spawn("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => resolveStop());
    killer.once("exit", () => resolveStop());
  });
}

async function launchServer() {
  const outputFd = openSync(outputLogPath, "a");
  const errorFd = openSync(errorLogPath, "a");
  const startedAt = Date.now();

  log("Starting TEMPO on http://127.0.0.1:3000/");
  const child = spawn(nodePath, [
    wranglerPath,
    "dev",
    "--config", wranglerConfigPath,
    "--local",
    "--ip", "127.0.0.1",
    "--port", "3000",
    "--persist-to", statePath,
    "--no-show-interactive-dev-session",
  ], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", outputFd, errorFd],
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: resolve(projectRoot, ".wrangler", "wrangler.log"),
    },
  });
  closeSync(outputFd);
  closeSync(errorFd);
  activeChild = child;
  consecutiveHealthFailures = 0;

  const healthTimer = setInterval(async () => {
    if (healthCheckRunning || shuttingDown || activeChild !== child) return;
    if (Date.now() - startedAt < 45_000) return;
    healthCheckRunning = true;
    try {
      if (await isHealthy()) {
        consecutiveHealthFailures = 0;
        return;
      }

      consecutiveHealthFailures += 1;
      log(`Health check failed (${consecutiveHealthFailures}/3).`);
      if (consecutiveHealthFailures >= 3) {
        log("Restarting the unresponsive TEMPO process tree.");
        await stopProcessTree(child.pid);
      }
    } finally {
      healthCheckRunning = false;
    }
  }, 20_000);

  const result = await new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => resolveExit({ code, signal, error: null }));
  });
  clearInterval(healthTimer);
  if (activeChild === child) activeChild = null;

  if (result.error) log(`TEMPO failed to start: ${result.error.message}`);
  else log(`TEMPO exited (code=${result.code ?? "null"}, signal=${result.signal ?? "none"}).`);
}

async function shutDown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Supervisor received ${signal}.`);
  await stopProcessTree(activeChild?.pid);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => void shutDown(signal));
}

while (!shuttingDown) {
  await launchServer();
  if (!shuttingDown) await delay(5_000);
}
