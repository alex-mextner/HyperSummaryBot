import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatHistoryRepository } from "../../src/db/repositories/chat-history";
import { initDatabase } from "../../src/db/client";
import { assertDatabaseReady, migrateApplicationDatabase } from "../../src/db/migrations";

describe("application database migrations", () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  test("creates a ready schema from an empty database", () => {
    db = initDatabase(":memory:");

    const result = migrateApplicationDatabase(db);

    expect(result.newlyRecorded).toBe(true);
    expect(result.messagesDeduplicated).toBe(0);
    expect(() => assertDatabaseReady(db)).not.toThrow();
  });

  test("deduplicates production-shaped messages by keeping the latest row", () => {
    db = initDatabase(":memory:");
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, user_name TEXT,
        role TEXT NOT NULL, content TEXT NOT NULL, reply_to_message_id INTEGER,
        forward_from_name TEXT, created_at INTEGER
      );
    `);
    db.query(`INSERT INTO messages
      (chat_id,message_id,user_id,user_name,role,content,created_at)
      VALUES (1,10,42,'42','user','Before',100)`).run();
    db.query(`INSERT INTO messages
      (chat_id,message_id,user_id,user_name,role,content,created_at)
      VALUES (1,10,42,'Alice @alice','user','After is richer',200)`).run();

    const result = migrateApplicationDatabase(db);
    const rows = db
      .query<{ id: number; content: string; user_name: string }, []>(
        "SELECT id,content,user_name FROM messages WHERE chat_id=1 AND message_id=10",
      )
      .all();

    expect(result.messagesDeduplicated).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("After is richer");
    expect(rows[0]!.user_name).toBe("Alice @alice");
    expect(() => assertDatabaseReady(db)).not.toThrow();
  });

  test("is idempotent and records the migration once", () => {
    db = initDatabase(":memory:");
    const first = migrateApplicationDatabase(db);
    const second = migrateApplicationDatabase(db);
    const count = db
      .query<{ count: number }, []>("SELECT count(*) count FROM app_schema_migrations")
      .get();

    expect(first.newlyRecorded).toBe(true);
    expect(second.newlyRecorded).toBe(false);
    expect(second.messagesDeduplicated).toBe(0);
    expect(count?.count).toBe(1);
  });

  test("rolls back instead of guessing when an existing table is incompatible", () => {
    db = initDatabase(":memory:");
    db.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL
    )`);

    expect(() => migrateApplicationDatabase(db)).toThrow("missing columns");
    const chats = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chats'",
      )
      .get();
    expect(chats).toBeNull();
  });

  test("readiness requires the expected migration record", () => {
    db = initDatabase(":memory:");
    migrateApplicationDatabase(db);
    db.exec("DELETE FROM app_schema_migrations");

    expect(() => assertDatabaseReady(db)).toThrow(
      "migration 2026_09_15_schema_readiness_v1 not recorded",
    );
  });

  test("readiness fails before migration and repository chat writes work after it", async () => {
    db = initDatabase(":memory:");
    expect(() => assertDatabaseReady(db)).toThrow("missing table");

    migrateApplicationDatabase(db);
    const repo = new ChatHistoryRepository(db);
    await repo.saveChat({ chatId: -1001, title: "Allowed group", type: "supergroup" });

    expect(await repo.getChat(-1001)).toEqual({ title: "Allowed group", type: "supergroup" });
  });
});
