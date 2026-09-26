import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Husky sets a repo-local core.hooksPath (.husky/_), which shadows the user's global hooks.
// Each husky hook must therefore also call the global dispatcher (agent-tools
// git-hooks/global-dispatcher), so the global secret scan and review gate still run here.
const ROOT = join(import.meta.dir, "../..");
const DISPATCHER = '"${XDG_CONFIG_HOME:-$HOME/.config}/git/run-global-hooks"';

/** Runs a husky hook the way husky does (`sh -e`) with stand-ins for npx and the dispatcher. */
function runHook(event: string, args: string[], dispatcherExit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "sb-hooks-"));
  try {
    const log = join(dir, "calls.log");
    const bin = join(dir, "bin");
    const dispatcherDir = join(dir, "config/git");
    mkdirSync(bin, { recursive: true });
    mkdirSync(dispatcherDir, { recursive: true });
    writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "npx $*" >> '${log}'\n`, { mode: 0o755 });
    writeFileSync(
      join(dispatcherDir, "run-global-hooks"),
      `#!/bin/sh\necho "dispatcher $*" >> '${log}'\nexit ${dispatcherExit}\n`,
      { mode: 0o755 },
    );
    const result = spawnSync("sh", ["-e", join(ROOT, ".husky", event), ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        XDG_CONFIG_HOME: join(dir, "config"),
      },
      encoding: "utf8",
    });
    let calls: string[] = [];
    try {
      calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    } catch {}
    return { status: result.status, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("husky hooks call the global git hook dispatcher", () => {
  for (const event of ["pre-commit", "pre-push"]) {
    test(`${event} is executable and calls the dispatcher for its event`, () => {
      const hook = join(ROOT, ".husky", event);
      expect(statSync(hook).mode & 0o111).not.toBe(0);
      expect(readFileSync(hook, "utf8")).toContain(`${DISPATCHER} ${event} "$@" || exit $?`);
    });
  }

  test("pre-commit runs the repository's lint-staged gate and then the global hooks", () => {
    const run = runHook("pre-commit", []);
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(["npx lint-staged", "dispatcher pre-commit"]);
  });

  test("pre-push passes git's arguments to the global hooks", () => {
    const run = runHook("pre-push", ["origin", "git@example.invalid:repo.git"]);
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(["dispatcher pre-push origin git@example.invalid:repo.git"]);
  });

  test("a failing global hook blocks the commit and the push", () => {
    expect(runHook("pre-commit", [], 1).status).not.toBe(0);
    expect(runHook("pre-push", ["origin", "git@example.invalid:repo.git"], 3).status).toBe(3);
  });
});
