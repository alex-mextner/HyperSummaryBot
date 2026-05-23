import { Database } from "bun:sqlite";
const db = new Database("/var/www/hyper-summary-bot/data/hyper-summary.db");
db.exec(`
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
`);
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS debts_chat_creditor_debtor_desc_unique ON debts(chat_id, creditor_user_id, debtor_user_id, description);`,
);
console.log("debts table created");
