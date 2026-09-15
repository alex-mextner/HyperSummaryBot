import { initDatabase } from "../src/db/client";
import { migrateApplicationDatabase } from "../src/db/migrations";

const databasePath = process.env.DATABASE_PATH || "./data/hyper-summary.db";
const db = initDatabase(databasePath);

try {
  const result = migrateApplicationDatabase(db);
  console.log(
    `[db:migrate] ${result.migrationId} recorded=${result.newlyRecorded} ` +
      `messages_deduplicated=${result.messagesDeduplicated}`,
  );
} finally {
  db.close();
}
