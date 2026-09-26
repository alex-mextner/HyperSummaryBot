import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Husky sets a repo-local core.hooksPath (.husky/_), which shadows the user's global hooks.
// The husky hooks therefore also call the global dispatcher (agent-tools
// git-hooks/global-dispatcher), so the global secret scan and main-branch protection still run.
// Wired events: pre-commit and pre-push, the ones with global fragments today. A future global
// commit-msg fragment would need a .husky/commit-msg as well.
const ROOT = join(import.meta.dir, "../..");
const PUSH_ARGS = ["origin", "git@example.invalid:repo.git"];

interface HookRun {
  status: number | null;
  stderr: string;
  calls: string[];
}

/**
 * Runs a husky hook the way husky does (`sh -e`) with stand-ins for npx and the dispatcher.
 * `dispatcherExit: null` leaves the dispatcher out, as on a machine without it.
 */
function runHook(
  event: string,
  args: string[],
  { npxExit = 0, dispatcherExit = 0 }: { npxExit?: number; dispatcherExit?: number | null } = {},
): HookRun {
  const dir = mkdtempSync(join(tmpdir(), "sb-hooks-"));
  try {
    const log = join(dir, "calls.log");
    const bin = join(dir, "bin");
    const dispatcherDir = join(dir, "config/git");
    mkdirSync(bin, { recursive: true });
    mkdirSync(dispatcherDir, { recursive: true });
    writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "npx $*" >> '${log}'\nexit ${npxExit}\n`, {
      mode: 0o755,
    });
    if (dispatcherExit !== null) {
      writeFileSync(
        join(dispatcherDir, "run-global-hooks"),
        `#!/bin/sh\necho "dispatcher $*" >> '${log}'\nexit ${dispatcherExit}\n`,
        { mode: 0o755 },
      );
    }
    const result = spawnSync("sh", ["-e", join(ROOT, ".husky", event), ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        XDG_CONFIG_HOME: join(dir, "config"),
      },
      encoding: "utf8",
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    return {
      status: result.status,
      stderr: `${result.stderr ?? ""}${result.error?.message ?? ""}`,
      calls,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("husky hooks call the global git hook dispatcher", () => {
  for (const event of ["pre-commit", "pre-push"]) {
    test(`${event} is executable and calls the dispatcher for its event`, () => {
      const hook = join(ROOT, ".husky", event);
      expect(statSync(hook).mode & 0o111).not.toBe(0);
      expect(readFileSync(hook, "utf8")).toContain(`/git/run-global-hooks" ${event} "$@"`);
    });
  }

  test("pre-commit runs the repository's lint-staged gate and then the global hooks", () => {
    const run = runHook("pre-commit", []);
    expect(run).toEqual({
      status: 0,
      stderr: "",
      calls: ["npx lint-staged", "dispatcher pre-commit"],
    });
  });

  test("a failing lint-staged blocks the commit before the global hooks run", () => {
    const run = runHook("pre-commit", [], { npxExit: 1 });
    expect(run.status).toBe(1);
    expect(run.calls).toEqual(["npx lint-staged"]);
  });

  test("a failing global pre-commit hook blocks the commit", () => {
    const run = runHook("pre-commit", [], { dispatcherExit: 1 });
    expect(run.status).toBe(1);
    expect(run.calls).toEqual(["npx lint-staged", "dispatcher pre-commit"]);
  });

  test("pre-push passes git's arguments to the global hooks", () => {
    const run = runHook("pre-push", PUSH_ARGS);
    expect(run).toEqual({
      status: 0,
      stderr: "",
      calls: [`dispatcher pre-push ${PUSH_ARGS.join(" ")}`],
    });
  });

  test("a failing global pre-push hook blocks the push with its exit status", () => {
    const run = runHook("pre-push", PUSH_ARGS, { dispatcherExit: 3 });
    expect(run.status).toBe(3);
    expect(run.calls).toEqual([`dispatcher pre-push ${PUSH_ARGS.join(" ")}`]);
  });

  test("without the global dispatcher, commits and pushes fail closed", () => {
    // Deliberate: a machine without rig's dispatcher must not silently skip the secret scan.
    const commit = runHook("pre-commit", [], { dispatcherExit: null });
    // The exact status depends on the shell (127 in dash, 1 in macOS sh); any failure blocks.
    expect(commit.status ?? 0).toBeGreaterThan(0);
    expect(commit.calls).toEqual(["npx lint-staged"]);
    expect(runHook("pre-push", PUSH_ARGS, { dispatcherExit: null }).status ?? 0).toBeGreaterThan(0);
  });
});
