// Manual schema creation for in-memory test databases (drizzle-orm does not auto-create tables)
export function createTestSchema(db: import("bun:sqlite").Database) {
  db.exec(`
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
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS messages_chat_message_unique ON messages(chat_id, message_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL UNIQUE,
      language TEXT DEFAULT 'en',
      timezone TEXT DEFAULT 'UTC',
      summary_style TEXT DEFAULT 'detailed',
      notion_database_id TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      message_ids TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL UNIQUE,
      title TEXT NOT NULL,
      type TEXT,
      username TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    );
  `);
}
