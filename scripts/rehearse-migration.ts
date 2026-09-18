import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Run only against a consistent, offline SQLite backup. The input is never edited.
 * Usage: bun scripts/rehearse-migration.ts <backup.db> [candidate-migrations.ts] */
const backupPath = process.argv[2];
if (!backupPath) throw new Error("Provide a consistent SQLite backup path");
const modulePath = process.argv[3]
  ? resolve(process.argv[3])
  : resolve(import.meta.dir, "../src/db/migrations.ts");
const { migrateApplicationDatabase } = await import(pathToFileURL(modulePath).href);
const directory = mkdtempSync(join(dirname(resolve(backupPath)), "rehearsal-"));
chmodSync(directory, 0o700);
const copyPath = join(directory, "copy.db");
copyFileSync(backupPath, copyPath);
chmodSync(copyPath, 0o600);
const db = new Database(copyPath);
const fingerprint = () =>
  createHash("sha256")
    .update(
      JSON.stringify(
        db
          .query(
            `SELECT id,chat_id,message_id,user_id,user_name,role,content,reply_to_message_id,forward_from_name,created_at FROM messages ORDER BY id`,
          )
          .all(),
      ),
    )
    .digest("hex");
try {
  const original = fingerprint();
  const before = db.query<{ n: number }, []>("SELECT count(*) n FROM messages").get()?.n;
  const first = migrateApplicationDatabase(db);
  const second = migrateApplicationDatabase(db);
  const after = db.query<{ n: number }, []>("SELECT count(*) n FROM messages").get()?.n;
  const integrity = Object.values(db.query("PRAGMA integrity_check").get() ?? {})[0];
  const preserved = original === fingerprint();
  if (!preserved || before !== after || second.newlyRecorded || integrity !== "ok")
    throw new Error("Migration rehearsal failed");
  console.log(
    JSON.stringify({
      evidence_scope: "real_db_copy_migration",
      rowsBefore: before,
      rowsAfter: after,
      originalFieldsUnchanged: preserved,
      repeatedRunNoop: !second.newlyRecorded,
      integrity,
      migrationId: first.migrationId,
      sourceDatesKnown: db
        .query("SELECT count(*) n FROM messages WHERE source_created_at IS NOT NULL")
        .get(),
    }),
  );
} finally {
  db.close();
  rmSync(directory, { recursive: true });
}
