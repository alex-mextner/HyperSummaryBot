// Stage artifacts are untrusted data; the installed Rig controller owns deployment.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  "runs-on": string | string[];
  needs?: string;
  if?: string;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}
const root = join(import.meta.dir, "..");
const workflowPath = ".github/workflows/rig-stage-build.yml";
const source = readFileSync(join(root, workflowPath), "utf8");
const workflow = Bun.YAML.parse(source) as Workflow;
const manifest = JSON.parse(readFileSync(join(root, ".rig/bot-stage.json"), "utf8"));
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const expression = (value: string) => `\${{ ${value} }}`;
const headExpression = expression("github.event.pull_request.head.sha");

describe("shared Rig stage artifact boundary", () => {
  test("PR code only runs on hosted runners with read-only repository access", () => {
    expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(workflow.jobs)) {
      expect(job["runs-on"]).toMatch(/^ubuntu-(latest|24\.04(?:-arm)?)$/);
    }
    expect(source).not.toMatch(
      /secrets\.|self-hosted|pull_request_target|statuses: write|packages: write/,
    );
  });

  test("the artifact build depends on successful application checks", () => {
    expect(workflow.jobs["build"]?.needs).toBe("checks");
    expect(workflow.jobs["checks"]?.if).toBeUndefined();
    const condition = workflow.jobs["build"]?.if ?? "";
    expect(condition).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(condition).toContain("!github.event.pull_request.draft");
    expect(condition).toContain("github.event.pull_request.user.type != 'Bot'");
    const commands = workflow.jobs["checks"]?.steps.map((step) => step.run).filter(Boolean);
    for (const check of ["bun x tsc --noEmit", "bun run lint", "bun run fmt:check", "bun run test"])
      expect(commands).toContain(check);
    expect(commands).toContain("bun install --frozen-lockfile");
  });

  test("every checkout is the exact PR revision without persisted credentials", () => {
    const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(2);
    for (const checkout of checkouts) {
      expect(checkout.with?.["ref"]).toBe(headExpression);
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }
  });

  test("all actions are pinned to complete immutable revisions", () => {
    for (const step of steps) {
      if (step.uses) expect(step.uses).toMatch(/^[\w./-]+@[a-f0-9]{40}$/);
    }
  });

  test("the image is loaded locally for an artifact and never published by PR code", () => {
    const build = steps.find((step) => step.uses?.startsWith("docker/build-push-action@"));
    expect(build?.with?.["push"]).toBe(false);
    expect(build?.with?.["load"]).toBe(true);
    expect(build?.with?.["platforms"]).toBe("linux/amd64");
    expect(build?.with?.["tags"]).toBe(`${manifest.image}:${headExpression}`);
    expect(build?.with?.["labels"]).toBe(`org.opencontainers.image.revision=${headExpression}`);
    const artifact = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(artifact?.with?.["name"]).toBe(`stage-${headExpression}`);
    expect(artifact?.with?.["path"]).toBe("stage-artifact/image.tar.gz");
    expect(artifact?.with?.["if-no-files-found"]).toBe("error");
  });

  test("the operator manifest pins the exact reviewed build workflow bytes", () => {
    const blob = createHash("sha1")
      .update(`blob ${Buffer.byteLength(source)}\0`)
      .update(source)
      .digest("hex");
    expect(manifest.trusted_build_blob).toBe(blob);
    expect(manifest.required_workflows).toEqual([workflowPath]);
    expect(manifest.build_workflow).toBe(workflowPath);
  });

  test("only the current production deploy declaration names a persistent runner", () => {
    const directory = join(root, ".github/workflows");
    const files = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const definition = Bun.YAML.parse(readFileSync(join(directory, file), "utf8")) as Workflow;
      for (const [name, job] of Object.entries(definition.jobs)) {
        if (file === "deploy.yml" && name === "deploy") {
          expect(Object.keys(definition.on)).not.toContain("pull_request");
          expect(Object.keys(definition.on)).not.toContain("pull_request_target");
        } else {
          expect(job["runs-on"]).toMatch(/^ubuntu-/);
        }
      }
    }
  });

  test("stage requests only its dedicated bot token and bounded temporary resources", () => {
    expect(manifest.env_allowlist).toEqual(["BOT_TOKEN"]);
    expect(manifest.required_env).toEqual(["BOT_TOKEN"]);
    expect(manifest.defaults.RIG_STAGE_LIMITED).toBe("true");
    expect(manifest.telegram_username).toMatch(/(?:stage|stg|test).*bot$/i);
    expect(manifest.memory_mb).toBeLessThanOrEqual(512);
    expect(manifest.cpus).toBeLessThanOrEqual(1);
    expect(manifest.pids).toBeLessThanOrEqual(256);
    expect(manifest.ttl_seconds).toBeLessThanOrEqual(3600);
    expect(manifest.defaults.DATABASE_PATH).toBe("/app/data/stage.db");
  });
});
