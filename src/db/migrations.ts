import type { Database } from "bun:sqlite";

const BASE_MIGRATION_ID = "2026_09_15_schema_readiness_v1";
const MIGRATION_ID = "2026_09_18_canonical_history_v2";
const CANONICAL_COLUMNS = {
  source_created_at: "INTEGER",
  source_edited_at: "INTEGER",
  thread_id: "INTEGER",
  source_kind: "TEXT NOT NULL DEFAULT 'legacy'",
  content_kind: "TEXT NOT NULL DEFAULT 'text'",
  content_version: "INTEGER NOT NULL DEFAULT 1",
};

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  messages: [
    "id",
    "chat_id",
    "message_id",
    "user_id",
    "user_name",
    "role",
    "content",
    "reply_to_message_id",
    "forward_from_name",
    "created_at",
  ],
  chat_configs: [
    "id",
    "chat_id",
    "language",
    "timezone",
    "summary_style",
    "notion_database_id",
    "created_at",
    "updated_at",
  ],
  summaries: ["id", "chat_id", "type", "content", "message_ids", "created_at"],
  chats: ["id", "chat_id", "title", "type", "username", "updated_at"],
  debts: [
    "id",
    "chat_id",
    "creditor_user_id",
    "creditor_user_name",
    "debtor_user_id",
    "debtor_user_name",
    "amount",
    "currency",
    "description",
    "source_message_ids",
    "created_at",
    "settled_at",
  ],
  app_schema_migrations: ["id", "applied_at"],
};

const TABLE_DDL = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to_message_id INTEGER,
  forward_from_name TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS chat_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  language TEXT DEFAULT 'en',
  timezone TEXT DEFAULT 'UTC',
  summary_style TEXT DEFAULT 'detailed',
  notion_database_id TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  message_ids TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  type TEXT,
  username TEXT,
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS debts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  creditor_user_id INTEGER NOT NULL,
  creditor_user_name TEXT,
  debtor_user_id INTEGER NOT NULL,
  debtor_user_name TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RSD',
  description TEXT,
  source_message_ids TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  settled_at INTEGER
);
`;

const INDEX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS messages_chat_message_unique
  ON messages(chat_id, message_id);
CREATE UNIQUE INDEX IF NOT EXISTS chat_configs_chat_id_unique
  ON chat_configs(chat_id);
CREATE UNIQUE INDEX IF NOT EXISTS chats_chat_id_unique
  ON chats(chat_id);
CREATE UNIQUE INDEX IF NOT EXISTS debts_chat_creditor_debtor_desc_unique
  ON debts(chat_id, creditor_user_id, debtor_user_id, description);
`;

function tableExists(db: Database, table: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(table) !== null
  );
}

function indexExists(db: Database, index: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1",
      )
      .get(index) !== null
  );
}

function assertCompatibleExistingTables(db: Database): void {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tableExists(db, table)) continue;
    const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    const columns = new Set(rows.map((row) => row.name));
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(`Incompatible ${table} table: missing columns ${missing.join(", ")}`);
    }
  }
}

function migrateCanonicalHistory(db: Database): void {
  const existing = new Map(
    db
      .query<{ name: string; type: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((row) => [row.name, row.type.toUpperCase()]),
  );
  for (const [name, declaration] of Object.entries(CANONICAL_COLUMNS)) {
    const type = existing.get(name);
    if (type !== undefined && type !== declaration.split(" ")[0])
      throw new Error(`Incompatible canonical message column ${name}`);
    if (type === undefined) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${declaration}`);
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS messages_chat_source_date ON messages(chat_id, source_created_at, message_id)",
  );
}

function duplicateMessageGroupCount(db: Database): number {
  if (!tableExists(db, "messages")) return 0;
  return (
    db
      .query<{ count: number }, []>(
        `SELECT count(*) AS count FROM (
          SELECT 1 FROM messages GROUP BY chat_id, message_id HAVING count(*) > 1
        )`,
      )
      .get()?.count ?? 0
  );
}

function deduplicateMessagesKeepLatest(db: Database): number {
  if (duplicateMessageGroupCount(db) === 0) return 0;
  // Repeated historical imports created duplicate rows. Keep the highest row ID,
  // which is the latest ingestion of the same Telegram (chat_id, message_id) key.
  db.exec(`
    DELETE FROM messages
    WHERE id NOT IN (
      SELECT MAX(id) FROM messages GROUP BY chat_id, message_id
    );
  `);
  return db.query<{ count: number }, []>("SELECT changes() AS count").get()?.count ?? 0;
}

export interface MigrationResult {
  migrationId: string;
  newlyRecorded: boolean;
  messagesDeduplicated: number;
}

export function migrateApplicationDatabase(db: Database): MigrationResult {
  db.exec("BEGIN IMMEDIATE;");
  try {
    assertCompatibleExistingTables(db);
    db.exec(TABLE_DDL);
    const messagesDeduplicated = deduplicateMessagesKeepLatest(db);
    db.exec(INDEX_DDL);
    migrateCanonicalHistory(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_schema_migrations (
        id TEXT PRIMARY KEY NOT NULL,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    db.query("INSERT OR IGNORE INTO app_schema_migrations (id) VALUES (?)").run(BASE_MIGRATION_ID);
    const exists = db
      .query<{ id: string }, [string]>("SELECT id FROM app_schema_migrations WHERE id = ? LIMIT 1")
      .get(MIGRATION_ID);
    if (!exists) {
      db.query("INSERT INTO app_schema_migrations (id) VALUES (?)").run(MIGRATION_ID);
    }
    // Validate all postconditions while rollback is still possible.
    assertDatabaseReady(db);
    db.exec("COMMIT;");
    assertDatabaseReady(db);
    return { migrationId: MIGRATION_ID, newlyRecorded: !exists, messagesDeduplicated };
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // The transaction may already be closed by SQLite after a fatal statement.
    }
    throw error;
  }
}

export function assertDatabaseReady(db: Database): void {
  assertCompatibleExistingTables(db);
  for (const table of Object.keys(REQUIRED_COLUMNS)) {
    if (!tableExists(db, table)) throw new Error(`Database is not ready: missing table ${table}`);
  }
  for (const index of [
    "messages_chat_message_unique",
    "chat_configs_chat_id_unique",
    "chats_chat_id_unique",
    "debts_chat_creditor_debtor_desc_unique",
  ]) {
    if (!indexExists(db, index)) throw new Error(`Database is not ready: missing index ${index}`);
  }
  const duplicates = duplicateMessageGroupCount(db);
  if (duplicates > 0) {
    throw new Error(`Database is not ready: ${duplicates} duplicate message key group(s)`);
  }
  const present = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((row) => row.name),
  );
  for (const name of Object.keys(CANONICAL_COLUMNS)) {
    if (!present.has(name))
      throw new Error(`Database is not ready: missing canonical column ${name}`);
  }
  for (const id of [BASE_MIGRATION_ID, MIGRATION_ID]) {
    const migration = db
      .query<{ id: string }, [string]>("SELECT id FROM app_schema_migrations WHERE id = ? LIMIT 1")
      .get(id);
    if (!migration) throw new Error(`Database is not ready: migration ${id} not recorded`);
  }
}
