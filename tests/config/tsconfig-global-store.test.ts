import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

// bun-types imports `undici-types` for Response/Request/Headers without declaring it as a
// dependency. With Bun's global store (`linker = "isolated"`, `globalStore = true`) packages
// realpath into ~/.bun/install/cache/links, so walking up from bun-types never reaches the
// project's hidden hoisted layer and the import silently degrades to `any` under skipLibCheck.
// tsconfig `paths` maps it to that layer; a hoisted install falls back to normal resolution.

const repoRoot = resolve(import.meta.dir, "../..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "summary-bot-types-"));
  tempDirs.push(dir);
  return dir;
}

function writeText(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// The repository tsconfig, with relative `paths` resolved against `configDir` as in a checkout.
function repoCompilerOptions(configDir: string): ts.CompilerOptions {
  const configPath = join(repoRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    configDir,
    undefined,
    join(configDir, "tsconfig.json"),
  );
  // TS18003 (no inputs) is expected: fixtures pass their own root file instead of `include`.
  const errors = parsed.errors.filter((d) => d.code !== 18003);
  if (errors.length > 0) {
    throw new Error(
      errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"),
    );
  }
  return parsed.options;
}

// Compiles `entry` and reports the type of its first variable declaration.
function compile(entry: string, options: ts.CompilerOptions) {
  const program = ts.createProgram([entry], options);
  const checker = program.getTypeChecker();
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  const statement = program.getSourceFile(entry)?.statements.find(ts.isVariableStatement);
  const declaration = statement?.declarationList.declarations[0];
  if (!declaration) throw new Error(`${entry} has no variable declaration`);
  return { diagnostics, type: checker.typeToString(checker.getTypeAtLocation(declaration.name)) };
}

function writeUndiciTypes(dir: string) {
  writeText(join(dir, "package.json"), '{"name":"undici-types","types":"index.d.ts"}');
  writeText(join(dir, "index.d.ts"), "export interface Probe { ok: boolean }\n");
}

function writeProbeTypes(dir: string) {
  writeText(join(dir, "package.json"), '{"name":"@types/probe","types":"index.d.ts"}');
  writeText(
    join(dir, "index.d.ts"),
    'declare global { var probe: import("undici-types").Probe; }\nexport {};\n',
  );
}

// A minimal stand-in for bun-types: a types package with an undeclared undici-types import.
function createFixture(layout: "global-store" | "hoisted") {
  const dir = tempDir();
  const project = join(dir, "project");
  if (layout === "global-store") {
    // The package lives outside the project; the project only holds links to it.
    const stored = join(dir, "links/@types+probe@1.0.0-0000000000000000/node_modules/@types/probe");
    writeProbeTypes(stored);
    writeUndiciTypes(join(project, "node_modules/.bun/node_modules/undici-types"));
    mkdirSync(join(project, "node_modules/@types"), { recursive: true });
    symlinkSync(stored, join(project, "node_modules/@types/probe"), "dir");
  } else {
    writeProbeTypes(join(project, "node_modules/@types/probe"));
    writeUndiciTypes(join(project, "node_modules/undici-types"));
  }
  const entry = join(project, "entry.ts");
  writeText(entry, "export const ok = probe.ok;\n");
  return { entry, options: { ...repoCompilerOptions(project), types: ["probe"] } };
}

describe("tsconfig undici-types resolution", () => {
  test("resolves an undeclared undici-types import from a global-store package", () => {
    const { entry, options } = createFixture("global-store");
    expect(compile(entry, options)).toEqual({ diagnostics: [], type: "boolean" });
  });

  test("the global-store fixture degrades to any without the paths mapping", () => {
    const { entry, options } = createFixture("global-store");
    delete options.paths;
    expect(compile(entry, options).type).toBe("any");
  });

  test("falls back to normal resolution in a hoisted install", () => {
    const { entry, options } = createFixture("hoisted");
    expect(compile(entry, options)).toEqual({ diagnostics: [], type: "boolean" });
  });

  test("the installed bun-types keep Response members in this checkout", () => {
    // Whatever layout this checkout was installed with (hoisted in CI, global store locally).
    const entry = join(tempDir(), "entry.ts");
    writeText(entry, "export const ok = new Response().ok;\n");
    expect(compile(entry, repoCompilerOptions(repoRoot))).toEqual({
      diagnostics: [],
      type: "boolean",
    });
  }, 30_000);
});
