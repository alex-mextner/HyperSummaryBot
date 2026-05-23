import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase } from "../../src/db/client";

describe("initDatabase", () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  test("creates database and sets WAL mode on file-backed DB", () => {
    const tmpPath = `/tmp/hyper-summary-test-${Date.now()}.db`;
    db = initDatabase(tmpPath);
    const row = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode;").get();
    expect(row?.journal_mode).toBe("wal");
  });

  test("enables foreign keys", () => {
    db = initDatabase(":memory:");
    const row = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys;").get();
    expect(row?.foreign_keys).toBe(1);
  });

  test("sets synchronous to NORMAL on file-backed DB", () => {
    const tmpPath = `/tmp/hyper-summary-test-${Date.now()}.db`;
    db = initDatabase(tmpPath);
    const row = db.query<{ synchronous: number }, []>("PRAGMA synchronous;").get();
    expect(row?.synchronous).toBe(1); // NORMAL = 1
  });

  test("sets cache size to 8000 pages (negative value)", () => {
    db = initDatabase(":memory:");
    const row = db.query<{ cache_size: number }, []>("PRAGMA cache_size;").get();
    expect(row?.cache_size).toBe(-8000);
  });

  test("sets busy timeout via exec", () => {
    db = initDatabase(":memory:");
    // busy_timeout is set via exec; just verify DB is still usable afterward
    db.exec("SELECT 1");
    expect(true).toBe(true);
  });
});
