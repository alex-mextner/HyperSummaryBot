import { mock, describe, test, expect, beforeEach } from "bun:test";
import "../setup";
import { Database } from "bun:sqlite";
import { initDatabase } from "../../src/db/client";
import { createTestSchema } from "../helpers/db-schema";
import { ChatHistoryRepository } from "../../src/db/repositories/chat-history";

// Shared mock client so getClient() singleton always returns the same cached instance
const sharedMockClient = {
  start: mock(() => Promise.resolve()),
  resolvePeer: mock(async (chatId: number) => ({ _: "inputPeerChat", chat_id: chatId })),
  call: mock(async (_params: any) => ({ messages: [] })),
  updates: {
    on: mock(() => {}),
    off: mock(() => {}),
  },
};

mock.module("@mtcute/bun", () => ({
  TelegramClient: class MockTelegramClient {
    constructor() {
      return sharedMockClient;
    }
  },
}));

import {
  importChatHistory,
  getUserGroups,
  startRealtimeSync,
  isMtProtoConfigured,
} from "../../src/services/mtproto";

describe("MTProto service", () => {
  let db: Database;
  let repo: ChatHistoryRepository;

  beforeEach(() => {
    db = initDatabase(":memory:");
    createTestSchema(db);
    repo = new ChatHistoryRepository(db);

    // Reset shared mock methods
    sharedMockClient.start.mockClear?.();
    sharedMockClient.resolvePeer.mockClear?.();
    sharedMockClient.call.mockClear?.();
    sharedMockClient.updates.on.mockClear?.();
    sharedMockClient.updates.off.mockClear?.();

    sharedMockClient.start = mock(() => Promise.resolve());
    sharedMockClient.resolvePeer = mock(async (chatId: number) => ({
      _: "inputPeerChat",
      chat_id: chatId,
    }));
    (sharedMockClient as any).call = mock(async (_params: any) => ({ messages: [] }));
    sharedMockClient.updates.on = mock(() => {});
    sharedMockClient.updates.off = mock(() => {});
  });

  test("isMtProtoConfigured returns true when configured", async () => {
    expect(await isMtProtoConfigured()).toBe(true);
  });

  test("importChatHistory returns imported and skipped counts", async () => {
    const result = await importChatHistory(repo, 1, { limit: 10 });
    expect(typeof result.imported).toBe("number");
    expect(typeof result.skipped).toBe("number");
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
  });

  test("importChatHistory fetches messages in batches", async () => {
    let callCount = 0;
    (sharedMockClient as any).call = mock(async (params: any) => {
      if (params._ === "messages.getHistory") {
        callCount++;
        const msgs = [
          {
            _: "message",
            id: callCount * 10 + 1,
            fromId: { userId: 42 },
            message: `Batch ${callCount}`,
            replyTo: null,
            fwdFrom: null,
          },
        ];
        return { messages: msgs };
      }
      return {};
    });

    const result = await importChatHistory(repo, 1, { limit: 5 });
    expect(result.imported + result.skipped).toBeGreaterThan(0);
  });

  test("importChatHistory dedups existing messages", async () => {
    await repo.save({
      chatId: 1,
      messageId: 100,
      userId: 1,
      userName: "User",
      role: "user",
      content: "Existing",
      replyToMessageId: null,
      forwardFromName: null,
    });

    (sharedMockClient as any).call = mock(async (params: any) => {
      if (params._ === "messages.getHistory") {
        return {
          messages: [
            {
              _: "message",
              id: 100,
              fromId: { userId: 1 },
              message: "Existing",
              replyTo: null,
              fwdFrom: null,
            },
          ],
        };
      }
      return {};
    });

    const result = await importChatHistory(repo, 1, { limit: 10 });
    expect(result.skipped).toBeGreaterThan(0);
  });

  test("getUserGroups returns group list", async () => {
    (sharedMockClient as any).call = mock(async (params: any) => {
      if (params._ === "messages.getDialogs") {
        return {
          dialogs: [
            { peer: { _: "peerChat", chatId: 1 } },
            { peer: { _: "peerChannel", channelId: 2 } },
          ],
          chats: [
            { _: "chat", id: 1, title: "Group One" },
            { _: "channel", id: 2, title: "Channel Two" },
          ],
        };
      }
      return {};
    });

    const groups = await getUserGroups();
    expect(groups.length).toBe(2);
    expect(groups[0]!.title).toBe("Group One");
    expect(groups[1]!.title).toBe("Channel Two");
  });

  test("startRealtimeSync returns dispose function", async () => {
    const dispose = await startRealtimeSync(repo);
    expect(typeof dispose).toBe("function");
    expect(() => dispose()).not.toThrow();
  });

  test("startRealtimeSync attaches update handler", async () => {
    await startRealtimeSync(repo);
    expect(sharedMockClient.updates.on.mock.calls.length).toBeGreaterThan(0);
  });

  test("update handler saves new messages", async () => {
    await startRealtimeSync(repo);
    const handler = (sharedMockClient.updates.on.mock.calls as any)[0][1];
    expect(typeof handler).toBe("function");

    await handler({
      _: "updateNewMessage",
      message: {
        _: "message",
        id: 999,
        peerId: { chatId: 1 },
        fromId: { userId: 42 },
        message: "Synced msg",
        replyTo: null,
        fwdFrom: null,
      },
    });

    const recent = await repo.getRecent(1, 10);
    expect(recent.some((m) => m.messageId === 999)).toBe(true);
  });

  test("update handler dedups existing messages", async () => {
    await repo.save({
      chatId: 1,
      messageId: 999,
      userId: 1,
      userName: "User",
      role: "user",
      content: "Already here",
      replyToMessageId: null,
      forwardFromName: null,
    });

    await startRealtimeSync(repo);
    const handler = (sharedMockClient.updates.on.mock.calls as any)[0][1];

    await handler({
      _: "updateNewMessage",
      message: {
        _: "message",
        id: 999,
        peerId: { chatId: 1 },
        fromId: { userId: 42 },
        message: "Synced msg",
        replyTo: null,
        fwdFrom: null,
      },
    });

    const recent = await repo.getRecent(1, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.content).toBe("Already here");
  });
});
