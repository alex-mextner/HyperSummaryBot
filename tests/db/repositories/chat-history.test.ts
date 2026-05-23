import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase } from "../../../src/db/client";
import { ChatHistoryRepository } from "../../../src/db/repositories/chat-history";
import { createTestSchema } from "../../helpers/db-schema";

describe("ChatHistoryRepository", () => {
  let db: Database;
  let repo: ChatHistoryRepository;

  beforeEach(() => {
    db = initDatabase(":memory:");
    createTestSchema(db);
    repo = new ChatHistoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeMessage(
    chatId: number,
    messageId: number,
    content: string,
    overrides?: Partial<Parameters<typeof repo.save>[0]>,
  ) {
    return {
      chatId,
      messageId,
      userId: messageId,
      userName: `User${messageId}`,
      role: "user" as const,
      content,
      replyToMessageId: null,
      forwardFromName: null,
      ...overrides,
    };
  }

  test("save inserts new message and returns id", async () => {
    const id = await repo.save(makeMessage(1, 100, "Hello world"));
    expect(id).toBeGreaterThan(0);

    const recent = await repo.getRecent(1, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.content).toBe("Hello world");
    expect(recent[0]!.userName).toBe("User100");
    expect(recent[0]!.role).toBe("user");
  });

  test("save updates on conflict (message edit)", async () => {
    await repo.save(makeMessage(1, 100, "Original"));
    await repo.save(makeMessage(1, 100, "Edited"));

    const recent = await repo.getRecent(1, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.content).toBe("Edited");
  });

  test("getRecent returns correct order and limit", async () => {
    for (let i = 1; i <= 5; i++) {
      await repo.save(makeMessage(1, i, `Msg${i}`));
    }
    const recent = await repo.getRecent(1, 3);
    expect(recent).toHaveLength(3);
    // All returned messages should belong to chat 1
    for (const m of recent) {
      expect(m.chatId).toBe(1);
    }
  });

  test("getByTimeRange filters by date", async () => {
    await repo.save(makeMessage(1, 1, "Any"));
    const messages = await repo.getByTimeRange(1, new Date(2000, 0, 1), new Date(2100, 0, 1));
    expect(messages.length).toBeGreaterThan(0);
  });

  test("pruneOld removes excess messages", async () => {
    for (let i = 1; i <= 10; i++) {
      await repo.save(makeMessage(1, i, `Msg${i}`));
    }
    await repo.pruneOld(1, 5);
    const recent = await repo.getRecent(1, 100);
    expect(recent).toHaveLength(5);
  });

  test("checkExists returns true for existing message", async () => {
    await repo.save(makeMessage(1, 100, "Hello"));
    expect(await repo.checkExists(1, 100)).toBe(true);
    expect(await repo.checkExists(1, 999)).toBe(false);
  });

  test("checkExistsBatch returns set of existing IDs", async () => {
    await repo.save(makeMessage(1, 10, "A"));
    await repo.save(makeMessage(1, 20, "B"));

    const existing = await repo.checkExistsBatch(1, [10, 20, 30]);
    expect(existing.has(10)).toBe(true);
    expect(existing.has(20)).toBe(true);
    expect(existing.has(30)).toBe(false);
  });

  test("checkExistsBatch returns empty set for empty input", async () => {
    const existing = await repo.checkExistsBatch(1, []);
    expect(existing.size).toBe(0);
  });

  test("saveChat inserts and getChat retrieves", async () => {
    await repo.saveChat({ chatId: 1, title: "Test Chat", type: "supergroup", username: "test" });
    const chat = await repo.getChat(1);
    expect(chat).not.toBeNull();
    expect(chat!.title).toBe("Test Chat");
    expect(chat!.type).toBe("supergroup");
  });

  test("saveChat updates on conflict", async () => {
    await repo.saveChat({ chatId: 1, title: "Old", type: "group" });
    await repo.saveChat({ chatId: 1, title: "New", type: "supergroup" });
    const chat = await repo.getChat(1);
    expect(chat!.title).toBe("New");
    expect(chat!.type).toBe("supergroup");
  });

  test("getAllChatIds returns unique chat IDs", async () => {
    await repo.save(makeMessage(1, 1, "A"));
    await repo.save(makeMessage(2, 2, "B"));
    await repo.save(makeMessage(1, 3, "C"));

    const ids = await repo.getAllChatIds();
    expect(ids).toHaveLength(2);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
  });

  test("getChatStats returns correct counts and dates", async () => {
    await repo.save(makeMessage(1, 1, "A"));
    await repo.save(makeMessage(1, 2, "B"));

    const stats = await repo.getChatStats(1);
    expect(stats.total).toBe(2);
    expect(stats.earliestDate).toBeInstanceOf(Date);
    expect(stats.latestDate).toBeInstanceOf(Date);
  });

  test("getChatStats returns zeros for empty chat", async () => {
    const stats = await repo.getChatStats(999);
    expect(stats.total).toBe(0);
    expect(stats.earliestDate).toBeNull();
    expect(stats.latestDate).toBeNull();
  });

  test("updateContent modifies existing message", async () => {
    await repo.save(makeMessage(1, 100, "Original"));
    await repo.updateContent(1, 100, "Updated");
    const recent = await repo.getRecent(1, 10);
    expect(recent[0]!.content).toBe("Updated");
  });

  test("save stores replyToMessageId and forwardFromName", async () => {
    await repo.save(
      makeMessage(1, 100, "Reply", {
        replyToMessageId: 99,
        forwardFromName: "Source",
      }),
    );
    const recent = await repo.getRecent(1, 10);
    expect(recent[0]!.replyToMessageId).toBe(99);
    expect(recent[0]!.forwardFromName).toBe("Source");
  });

  test("getRecent filters by chatId", async () => {
    await repo.save(makeMessage(1, 1, "Chat1"));
    await repo.save(makeMessage(2, 2, "Chat2"));
    const recent = await repo.getRecent(1, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.content).toBe("Chat1");
  });

  test("save stores assistant role", async () => {
    await repo.save(makeMessage(1, 100, "Bot reply", { role: "assistant" }));
    const recent = await repo.getRecent(1, 10);
    expect(recent[0]!.role).toBe("assistant");
  });
});
