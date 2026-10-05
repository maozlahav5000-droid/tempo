/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS?: Fetcher;
  DB: D1Database;
  FILES: KVNamespace;
  TEMPO_ACCESS_TOKEN?: string;
  IMAGES?: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

const ACCESS_COOKIE = "tempo_cloud_access";

function hasAccessCookie(cookieHeader: string | null, accessToken: string) {
  return (cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .some((part) => part === `${ACCESS_COOKIE}=${accessToken}`);
}

function accessRequiredResponse(request: Request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    return Response.json({ error: "נדרש קישור הגישה הפרטי של TEMPO." }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

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
    <p style="margin:0;color:#a8b5af;line-height:1.7">יש לפתוח את הקישור הפרטי המלא שנוצר עבור האתר.</p>
  </main>
</body>
</html>`;
  return new Response(body, {
    status: 401,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function serviceUnavailableResponse(message: string) {
  const body = `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0a0f0d">
  <title>TEMPO — השירות אינו זמין</title>
</head>
<body style="margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;box-sizing:border-box;color:#f5f7f6;background:#0a0f0d;font-family:Arial,sans-serif;text-align:center">
  <main style="max-width:460px;border:1px solid #2b3833;border-radius:22px;background:#121a17;padding:28px">
    <div style="font-size:42px" aria-hidden="true">♪</div>
    <h1 style="margin:12px 0 8px">הפרויקט אינו זמין כרגע</h1>
    <p style="margin:0;color:#a8b5af;line-height:1.7">${message}</p>
  </main>
</body>
</html>`;

  return new Response(body, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const accessToken = env.TEMPO_ACCESS_TOKEN?.trim();

    // Keep the first cloud deployment closed even before the secret is added.
    // Local development remains available without a token.
    if (!accessToken && url.hostname.endsWith(".workers.dev")) {
      return accessRequiredResponse(request);
    }

    if (accessToken) {
      const queryToken = url.searchParams.get("access");
      if (queryToken === accessToken) {
        url.searchParams.delete("access");
        const cleanLocation = `${url.pathname}${url.search}${url.hash}` || "/";
        return new Response(null, {
          status: 302,
          headers: {
            Location: cleanLocation,
            "Set-Cookie": `${ACCESS_COOKIE}=${accessToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      }

      if (!hasAccessCookie(request.headers.get("Cookie"), accessToken)) {
        return accessRequiredResponse(request);
      }
    }

    if (url.pathname === "/_vinext/image") {
      if (!env.ASSETS || !env.IMAGES) {
        return serviceUnavailableResponse("שירות התמונות של TEMPO לא הוגדר כראוי. יש לנסות שוב לאחר רענון.");
      }
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    // Cloudflare's static asset router is configured to send /projects/* here
    // first.  Serve those files only after the private-access gate above.
    if (url.pathname.startsWith("/projects/")) {
      if (!env.ASSETS) {
        return serviceUnavailableResponse("קובצי הפרויקט לא הוגדרו כראוי. יש לנסות שוב לאחר רענון.");
      }
      return env.ASSETS.fetch(request);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
