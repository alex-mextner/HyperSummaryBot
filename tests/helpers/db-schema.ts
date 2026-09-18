import { migrateApplicationDatabase } from "../../src/db/migrations";

/** Tests exercise exactly the same migrations as production, not a parallel DDL. */
export function createTestSchema(db: import("bun:sqlite").Database): void {
  migrateApplicationDatabase(db);
}
