import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateApplicationDatabase } from "../../src/db/migrations";
import { ChatHistoryRepository } from "../../src/db/repositories/chat-history";
let db: Database;
let repo: ChatHistoryRepository;
beforeEach(() => {
  db = new Database(":memory:");
  migrateApplicationDatabase(db);
  repo = new ChatHistoryRepository(db);
});
afterEach(() => db.close());
const message = (id: number, extra: Record<string, unknown> = {}) => ({
  chatId: -100123,
  messageId: id,
  userId: 42,
  userName: "Alice",
  role: "user" as const,
  content: "source",
  replyToMessageId: null,
  forwardFromName: null,
  ...extra,
});

test("source time differs from ingestion and unknown source time stays unknown", async () => {
  const posted = new Date("2026-05-01T10:00:00Z");
  await repo.save(message(1, { sourceCreatedAt: posted, sourceKind: "mtproto" }));
  await repo.save(message(2));
  const rows = await repo.getRecent(-100123, 10);
  expect(rows[0]?.sourceCreatedAt?.toISOString()).toBe(posted.toISOString());
  expect(rows[0]?.createdAt.getTime()).toBeGreaterThan(posted.getTime());
  expect(rows[1]?.sourceCreatedAt).toBeNull();
});
test("reverse-order imports do not reverse Telegram message chronology", async () => {
  for (const id of [3, 2, 1]) await repo.save(message(id));
  expect((await repo.getRecent(-100123, 2)).map((x) => x.messageId)).toEqual([2, 3]);
});
test("time queries never substitute ingestion time for unknown source dates", async () => {
  await repo.save(message(1));
  expect(
    await repo.getByTimeRange(-100123, new Date("2000-01-01"), new Date("2100-01-01")),
  ).toHaveLength(0);
});
test("media reimport cannot overwrite an existing voice transcription", async () => {
  await repo.save(
    message(1, { content: "actual words", contentKind: "transcription", sourceKind: "bot_api" }),
  );
  await repo.save(
    message(1, { content: "[Media/Empty]", contentKind: "placeholder", sourceKind: "mtproto" }),
  );
  expect((await repo.getRecent(-100123, 2))[0]?.content).toBe("actual words");
});
test("older edit cannot resurrect superseded content", async () => {
  await repo.save(
    message(1, { content: "cancelled", sourceEditedAt: new Date("2026-09-18T11:00:00Z") }),
  );
  await repo.save(
    message(1, { content: "proposed", sourceEditedAt: new Date("2026-09-18T10:00:00Z") }),
  );
  expect((await repo.getRecent(-100123, 1))[0]?.content).toBe("cancelled");
});
test("unchanged replay keeps content version and original ingestion time", async () => {
  const input = message(1, {
    threadId: 4,
    replyToMessageId: 3,
    sourceCreatedAt: new Date("2026-05-01T10:00:00Z"),
  });
  await repo.save(input);
  const before = (await repo.getRecent(-100123, 1))[0];
  await repo.save(input);
  const replay = (await repo.getRecent(-100123, 1))[0];
  expect(replay?.contentVersion).toBe(1);
  expect(replay?.threadId).toBe(4);
  expect(replay?.createdAt.getTime()).toBe(before?.createdAt.getTime());
  await repo.save({ ...input, content: "updated" });
  expect((await repo.getRecent(-100123, 1))[0]?.contentVersion).toBe(2);
});
test("migration is additive and never guesses old source timestamps", () => {
  db.exec(
    "INSERT INTO messages(chat_id,message_id,user_id,role,content,created_at) VALUES(-10,11,42,'user','old',12345)",
  );
  const result = db
    .query("SELECT source_created_at,created_at FROM messages WHERE chat_id=-10")
    .get();
  expect(result).toEqual({ source_created_at: null, created_at: 12345 });
  migrateApplicationDatabase(db);
  expect(db.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 1 });
});

test("late transcription failure cannot replace successful speech text", async () => {
  await repo.save(message(1, { content: "speech", contentKind: "transcription" }));
  await repo.updateContent(-100123, 1, "[Voice message - transcription failed]", "placeholder");
  expect((await repo.getRecent(-100123, 1))[0]?.content).toBe("speech");
});

test("persistence outcomes separate insert update and unchanged replay", async () => {
  const input = message(1);
  expect((await repo.saveWithOutcome(input)).outcome).toBe("inserted");
  expect((await repo.saveWithOutcome(input)).outcome).toBe("unchanged");
  expect((await repo.saveWithOutcome({ ...input, content: "changed" })).outcome).toBe("updated");
});
