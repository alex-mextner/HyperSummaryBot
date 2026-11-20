import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function runProvider(variables: Record<string, string> = {}) {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../.rig/bot-stage.json"), "utf8"),
  );
  const directory = mkdtempSync(join(tmpdir(), "stage-ai-"));
  const modulePath = resolve(import.meta.dir, "../../src/services/ai/streaming.ts");
  const script = `
let requests = 0;
globalThis.fetch = async () => { requests += 1; return new Response("{}", { status: 401 }); };
const { aiStreamRound } = await import(${JSON.stringify(modulePath)});
try {
  await aiStreamRound({ messages: [{ role: "user", content: "synthetic fixture" }], maxTokens: 16, deadlineMs: 5000 }, {});
  throw new Error("an unconfigured provider succeeded");
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code, requests }));
}
`;
  try {
    const result = spawnSync(process.execPath, ["--no-env-file", "-e", script], {
      cwd: directory,
      env: {
        PATH: process.env.PATH ?? "",
        ...manifest.defaults,
        BOT_TOKEN: "test-stage-token",
        LOG_LEVEL: "silent",
        ...variables,
      },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("limited stage without provider credentials makes no AI request", () => {
  expect(runProvider()).toEqual({ code: "provider_configuration", requests: 0 });
});

test("a fully configured provider remains in the normal attempt chain", () => {
  expect(
    runProvider({
      ZAI_API_KEY: "synthetic-key",
      ZAI_BASE_URL: "https://provider.invalid/v1",
      ZAI_MODEL: "fixture",
      ZAI_FAST_MODEL: "fixture",
    }),
  ).toEqual({ code: "authentication", requests: 1 });
});
