import { describe, test, expect } from "bun:test";
import { buildConnectAccountStatus, handleConnectAccount } from "../../src/bot/connect-account";
import { createTestSchema } from "../helpers/db-schema";
import { initDatabase } from "../../src/db/client";
import { ChatHistoryRepository } from "../../src/db/repositories/chat-history";

describe("buildConnectAccountStatus", () => {
  test("returns not-configured text when MTProto missing", async () => {
    const text = await buildConnectAccountStatus({
      isMtProtoConfigured: false,
      chatHistory: null as any,
    });
    expect(text).toContain("MTProto не настроен");
  });

  test("returns empty-history text when no chats", async () => {
    const db = initDatabase(":memory:");
    createTestSchema(db);
    const repo = new ChatHistoryRepository(db);

    const text = await buildConnectAccountStatus({
      isMtProtoConfigured: true,
      chatHistory: repo,
    });

    expect(text).toContain("Статус импорта истории");
    expect(text).toContain("История еще не импортирована");
    expect(text).toContain("Подключение Telegram аккаунта");
    db.close();
  });

  test("includes chat stats when history exists", async () => {
    const db = initDatabase(":memory:");
    createTestSchema(db);
    const repo = new ChatHistoryRepository(db);

    await repo.saveChat({ chatId: 1, title: "Test Chat" });
    await repo.save({
      chatId: 1,
      messageId: 1,
      userId: 1,
      userName: "User",
      role: "user",
      content: "Hello",
      replyToMessageId: null,
      forwardFromName: null,
    });

    const text = await buildConnectAccountStatus({
      isMtProtoConfigured: true,
      chatHistory: repo,
    });

    expect(text).toContain("Test Chat");
    expect(text).toContain("1 сообщений");
    db.close();
  });
});

describe("handleConnectAccount", () => {
  test("replies with DM-only message in groups", async () => {
    const replies: string[] = [];
    const ctx = {
      chat: { id: 1, type: "supergroup" as const },
      reply: async (text: string) => {
        replies.push(text);
      },
    };

    await handleConnectAccount(ctx as any, null as any);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("только в личных сообщениях");
  });

  test("replies with not-configured when MTProto missing", async () => {
    const replies: string[] = [];
    const ctx = {
      chat: { id: 1, type: "private" as const },
      reply: async (text: string) => {
        replies.push(text);
      },
    };

    await handleConnectAccount(ctx as any, null as any, { mtprotoConfigured: false });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("MTProto не настроен");
  });

  test("replies with status when everything ok", async () => {
    const db = initDatabase(":memory:");
    createTestSchema(db);
    const repo = new ChatHistoryRepository(db);

    const replies: string[] = [];
    const ctx = {
      chat: { id: 1, type: "private" as const },
      reply: async (text: string, _opts?: any) => {
        replies.push(text);
      },
    };

    await handleConnectAccount(ctx as any, repo, { mtprotoConfigured: true });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Статус импорта истории");
    db.close();
  });

  test("never throws — always replies something", async () => {
    const replies: string[] = [];
    const ctx = {
      chat: { id: 1, type: "private" as const },
      reply: async (text: string) => {
        replies.push(text);
      },
    };

    // Even with null repo (which would crash buildConnectAccountStatus)
    // handleConnectAccount should catch and reply with error
    await handleConnectAccount(ctx as any, null as any, { mtprotoConfigured: true });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Что-то пошло не так");
  });
});
