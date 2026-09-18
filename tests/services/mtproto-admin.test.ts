import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeAdminOtp,
  normalizeAdminPhone,
  prepareMtProtoSessionStorage,
} from "../../src/services/mtproto-admin";

let temporaryDirectory: string | undefined;

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("MTProto admin session helpers", () => {
  test("normalizes admin phone and OTP without logging them", () => {
    expect(normalizeAdminPhone("+381 64-123-4567")).toBe("+381641234567");
    expect(normalizeAdminOtp("1 2 3-4 5")).toBe("12345");
  });

  test("rejects malformed credentials before touching Telegram", () => {
    expect(() => normalizeAdminPhone("abc")).toThrow("international format");
    expect(() => normalizeAdminOtp("1234")).toThrow("exactly 5 digits");
  });

  test("does not chmod an existing parent directory", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "hs-mtproto-parent-"));
    const existingParent = join(temporaryDirectory, "shared");
    mkdirSync(existingParent, { mode: 0o755 });
    chmodSync(existingParent, 0o755);

    prepareMtProtoSessionStorage(join(existingParent, "session"));

    expect(statSync(existingParent).mode & 0o777).toBe(0o755);
  });

  test("locks the session directory and existing SQLite files down", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "hs-mtproto-"));
    const sessionPath = join(temporaryDirectory, "nested", "session");
    prepareMtProtoSessionStorage(sessionPath);
    writeFileSync(sessionPath, "session-placeholder", { mode: 0o644 });
    writeFileSync(`${sessionPath}-wal`, "wal-placeholder", { mode: 0o644 });

    prepareMtProtoSessionStorage(sessionPath);

    expect(statSync(join(temporaryDirectory, "nested")).mode & 0o777).toBe(0o700);
    expect(statSync(sessionPath).mode & 0o777).toBe(0o600);
    expect(statSync(`${sessionPath}-wal`).mode & 0o777).toBe(0o600);
  });
});
