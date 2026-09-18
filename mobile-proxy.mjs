import { createServer, request as createUpstreamRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const upstreamHost = "127.0.0.1";
const upstreamPort = 3000;
const listenPort = 3000;
const accessTokenPath = resolve(process.cwd(), ".tempo-server", "mobile-access-token.txt");
const accessToken = readFileSync(accessTokenPath, "utf8").trim();

if (!accessToken) throw new Error("TEMPO mobile access token is missing.");

function findTailscaleAddress() {
  const interfaces = networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!/tailscale/i.test(name)) continue;
    const address = addresses?.find((candidate) => {
      if (candidate.family !== "IPv4" || candidate.internal) return false;
      const [firstOctet, secondOctet] = candidate.address.split(".").map(Number);
      return firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127;
    });
    if (address) return address.address;
  }
  return null;
}

function hasAccessCookie(cookieHeader = "") {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .some((part) => part === `tempo_mobile_access=${accessToken}`);
}

function sendAccessRequired(response) {
  const body = `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0a0f0d">
  <title>TEMPO — גישה פרטית</title>
</head>
<body style="margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;box-sizing:border-box;color:#f5f7f6;background:#0a0f0d;font-family:Arial,sans-serif;text-align:center">
  <main style="max-width:420px;border:1px solid #2b3833;border-radius:22px;background:#121a17;padding:28px">
    <div style="font-size:42px" aria-hidden="true">♪</div>
    <h1 style="margin:12px 0 8px">נדרש קישור הגישה של TEMPO</h1>
    <p style="margin:0;color:#a8b5af;line-height:1.7">פתחו בנייד את הקישור הפרטי המלא שנוצר עבורכם במחשב.</p>
  </main>
</body>
</html>`;
  response.writeHead(401, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

const listenHost = findTailscaleAddress();
if (!listenHost) throw new Error("No active Tailscale IPv4 address was found.");

const server = createServer((incomingRequest, outgoingResponse) => {
  const requestUrl = new URL(incomingRequest.url ?? "/", `http://${listenHost}:${listenPort}`);
  const queryToken = requestUrl.searchParams.get("access");

  if (queryToken === accessToken) {
    requestUrl.searchParams.delete("access");
    const cleanLocation = `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`;
    outgoingResponse.writeHead(302, {
      Location: cleanLocation || "/",
      "Set-Cookie": `tempo_mobile_access=${accessToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
      "Cache-Control": "no-store",
    });
    outgoingResponse.end();
    return;
  }

  if (!hasAccessCookie(incomingRequest.headers.cookie)) {
    sendAccessRequired(outgoingResponse);
    return;
  }

  const forwardedHeaders = {
    ...incomingRequest.headers,
    host: `${upstreamHost}:${upstreamPort}`,
    "x-forwarded-host": incomingRequest.headers.host ?? `${listenHost}:${listenPort}`,
    "x-forwarded-proto": "http",
  };

  const upstreamRequest = createUpstreamRequest({
    hostname: upstreamHost,
    port: upstreamPort,
    method: incomingRequest.method,
    path: incomingRequest.url,
    headers: forwardedHeaders,
  }, (upstreamResponse) => {
    outgoingResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(outgoingResponse);
  });

  upstreamRequest.on("error", () => {
    if (outgoingResponse.headersSent) {
      outgoingResponse.destroy();
      return;
    }
    const body = "TEMPO עולה מחדש. נסו לרענן בעוד כמה שניות.";
    outgoingResponse.writeHead(503, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "Retry-After": "5",
    });
    outgoingResponse.end(body);
  });

  incomingRequest.on("aborted", () => upstreamRequest.destroy());
  incomingRequest.pipe(upstreamRequest);
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(listenPort, listenHost, () => {
  process.stdout.write(`[${new Date().toISOString()}] TEMPO mobile access listening on http://${listenHost}:${listenPort}/\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
