// Stage startup can omit production provider credentials only for an explicit dedicated stage identity.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function loadStage(variables: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "rig-stage-env-"));
  const module = resolve(import.meta.dir, "../../src/config/env.ts");
  const script = `const { loadConfig } = await import(${JSON.stringify(module)});
const config = loadConfig();
process.stdout.write(JSON.stringify([config.ZAI_API_KEY, config.HF_TOKEN]));`;
  try {
    return spawnSync(process.execPath, ["--no-env-file", "-e", script], {
      cwd: directory,
      env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test", ...variables },
      encoding: "utf8",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const stage = {
  BOT_TOKEN: "test-stage-token",
  BOT_USERNAME: "HyperSummaryStageBot",
};

test("dedicated limited stage starts with empty provider credentials", () => {
  const result = loadStage({ ...stage, RIG_STAGE_LIMITED: "true" });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual(["", ""]);
});

test("normal startup still requires its production provider configuration", () => {
  const result = loadStage(stage);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("ZAI_API_KEY");
});

test("limited stage mode rejects a production bot username", () => {
  const result = loadStage({ ...stage, RIG_STAGE_LIMITED: "true", BOT_USERNAME: "ProductionBot" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("dedicated stage");
});

test("limited stage still requires a real bot credential", () => {
  const result = loadStage({ ...stage, BOT_TOKEN: "", RIG_STAGE_LIMITED: "true" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("BOT_TOKEN");
});

test("reviewed manifest defaults and the dedicated token support limited startup", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../.rig/bot-stage.json"), "utf8"),
  );
  const result = loadStage({ ...manifest.defaults, BOT_TOKEN: "test-stage-token" });
  expect(result.status).toBe(0);
});
