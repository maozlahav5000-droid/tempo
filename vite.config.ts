import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";

const TEMPO_DATABASE_ID = "9f1a7fa5-70c6-44d9-a4c9-762400140e36";
const TEMPO_DATABASE_NAME = "tempo-db";
const TEMPO_FILES_NAMESPACE_ID = "155f4208473346448320c6e91b477276";

const { d1, kv } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  name: "tempo",
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  // Project players are otherwise served directly by Cloudflare's asset
  // router and would bypass the private-access check in worker/index.ts.
  assets: { run_worker_first: ["/projects/*"] },
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: TEMPO_DATABASE_NAME,
          database_id: TEMPO_DATABASE_ID,
        },
      ]
    : [],
  kv_namespaces: kv
    ? [
        {
          binding: kv,
          id: TEMPO_FILES_NAMESPACE_ID,
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      host: "127.0.0.1",
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
