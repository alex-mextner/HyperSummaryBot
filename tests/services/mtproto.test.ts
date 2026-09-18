import { mock, describe, test, expect, beforeEach } from "bun:test";
import "../setup";
import { Database } from "bun:sqlite";
import { initDatabase } from "../../src/db/client";
import { createTestSchema } from "../helpers/db-schema";
import { ChatHistoryRepository } from "../../src/db/repositories/chat-history";

function createEmitterMock() {
  return {
    add: mock((_handler: unknown) => {}),
    remove: mock((_handler: unknown) => {}),
  };
}

// Shared mock client so getClient() singleton always returns the same cached instance
const sharedMockClient = {
  start: mock(() => Promise.resolve()),
  destroy: mock(() => Promise.resolve()),
  resolvePeer: mock(async (chatId: number) => ({ _: "inputPeerChat", chat_id: chatId })),
  call: mock(async (_params: any) => ({ messages: [] })),
  onNewMessage: createEmitterMock(),
  onEditMessage: createEmitterMock(),
  onDeleteMessage: createEmitterMock(),
};

function highLevelMessage(options: {
  id: number;
  chatId: number;
  text: string;
  userId?: number;
  privateDialog?: boolean;
}) {
  const userId = options.userId ?? 42;
  return {
    id: options.id,
    chat: options.privateDialog
      ? { type: "user", id: options.chatId }
      : { type: "chat", id: options.chatId },
    sender: { id: userId, username: "tester", displayName: "Test User" },
    text: options.text,
    replyToMessage: null,
    forward: null,
  };
}

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
  shutdownMtProto,
} from "../../src/services/mtproto";

describe("MTProto service", () => {
  const allowedChatIds = new Set<number>([-1, -1000000000002]);
  let db: Database;
  let repo: ChatHistoryRepository;

  beforeEach(async () => {
    db = initDatabase(":memory:");
    createTestSchema(db);
    repo = new ChatHistoryRepository(db);

    // Dispose a listener left by a previous test before clearing call history.
    await startRealtimeSync(repo, new Set());
    sharedMockClient.start.mockClear?.();
    sharedMockClient.resolvePeer.mockClear?.();
    sharedMockClient.call.mockClear?.();
    sharedMockClient.onNewMessage.add.mockClear?.();
    sharedMockClient.onNewMessage.remove.mockClear?.();
    sharedMockClient.onEditMessage.add.mockClear?.();
    sharedMockClient.onEditMessage.remove.mockClear?.();
    sharedMockClient.onDeleteMessage.add.mockClear?.();
    sharedMockClient.onDeleteMessage.remove.mockClear?.();

    sharedMockClient.start = mock(() => Promise.resolve());
    sharedMockClient.resolvePeer = mock(async (chatId: number) => ({
      _: "inputPeerChat",
      chat_id: chatId,
    }));
    (sharedMockClient as any).call = mock(async (_params: any) => ({ messages: [] }));
  });

  test("isMtProtoConfigured returns true when configured", async () => {
    expect(await isMtProtoConfigured()).toBe(true);
  });

  test("importChatHistory returns imported and skipped counts", async () => {
    const result = await importChatHistory(repo, 1, { limit: 10, allowedChatIds });
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

    const result = await importChatHistory(repo, 1, { limit: 5, allowedChatIds });
    expect(result.imported + result.skipped).toBeGreaterThan(0);
  });

  test("importChatHistory dedups existing messages", async () => {
    await repo.save({
      chatId: -1,
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

    const result = await importChatHistory(repo, 1, { limit: 10, allowedChatIds });
    expect(result.skipped).toBeGreaterThan(0);
  });

  test("importChatHistory rejects a source outside the allowlist", async () => {
    await expect(importChatHistory(repo, 2, { limit: 10, allowedChatIds })).rejects.toThrow(
      "not allowlisted",
    );
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

  test("startRealtimeSync registers typed high-level message handlers", async () => {
    await startRealtimeSync(repo, allowedChatIds);
    expect(sharedMockClient.onNewMessage.add.mock.calls).toHaveLength(1);
    expect(sharedMockClient.onEditMessage.add.mock.calls).toHaveLength(1);
    expect(sharedMockClient.onDeleteMessage.add.mock.calls).toHaveLength(1);
  });

  test("new-message handler persists the SDK high-level message shape", async () => {
    await startRealtimeSync(repo, allowedChatIds);
    const handler = (sharedMockClient.onNewMessage.add.mock.calls as any)[0][0];

    await handler(highLevelMessage({ id: 999, chatId: -1, text: "Synced msg" }));

    const recent = await repo.getRecent(-1, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.messageId).toBe(999);
    expect(recent[0]!.userId).toBe(42);
    expect(recent[0]!.userName).toBe("Test User @tester");
    expect(recent[0]!.content).toBe("Synced msg");
  });

  test("edit-message handler upserts the existing message", async () => {
    await startRealtimeSync(repo, allowedChatIds);
    const newHandler = (sharedMockClient.onNewMessage.add.mock.calls as any)[0][0];
    const editHandler = (sharedMockClient.onEditMessage.add.mock.calls as any)[0][0];

    await newHandler(highLevelMessage({ id: 1000, chatId: -1, text: "Before" }));
    await editHandler(highLevelMessage({ id: 1000, chatId: -1, text: "After" }));

    const recent = await repo.getRecent(-1, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.content).toBe("After");
  });

  test("realtime sync never persists private dialogs even on numeric collision", async () => {
    const collisionAllowlist = new Set<number>([-42]);
    await startRealtimeSync(repo, collisionAllowlist);
    const handler = (sharedMockClient.onNewMessage.add.mock.calls as any)[0][0];

    await handler(
      highLevelMessage({ id: 1002, chatId: -42, text: "Private message", privateDialog: true }),
    );

    expect(await repo.getRecent(-42, 10)).toHaveLength(0);
  });

  test("empty source allowlist does not start the MTProto client", async () => {
    const startsBefore = sharedMockClient.start.mock.calls.length;
    const dispose = await startRealtimeSync(repo, new Set());
    expect(sharedMockClient.start.mock.calls.length).toBe(startsBefore);
    expect(typeof dispose).toBe("function");
  });

  test("realtime sync ignores a source outside the allowlist", async () => {
    await startRealtimeSync(repo, allowedChatIds);
    const handler = (sharedMockClient.onNewMessage.add.mock.calls as any)[0][0];

    await handler(highLevelMessage({ id: 1001, chatId: -2, text: "Should not persist" }));

    expect(await repo.getRecent(-2, 10)).toHaveLength(0);
  });

  test("delete handler removes allowlisted channel messages", async () => {
    const channelId = -1000000000002;
    await repo.save({
      chatId: channelId,
      messageId: 2000,
      userId: 42,
      userName: "User",
      role: "user",
      content: "Delete me",
      replyToMessageId: null,
      forwardFromName: null,
    });
    await startRealtimeSync(repo, allowedChatIds);
    const handler = (sharedMockClient.onDeleteMessage.add.mock.calls as any)[0][0];

    await handler({ channelId, messageIds: [2000] });

    expect(await repo.getRecent(channelId, 10)).toHaveLength(0);
  });

  test("non-channel delete is skipped because the source chat is unavailable", async () => {
    await repo.save({
      chatId: -1,
      messageId: 2001,
      userId: 42,
      userName: "User",
      role: "user",
      content: "Keep until source can be resolved",
      replyToMessageId: null,
      forwardFromName: null,
    });
    await startRealtimeSync(repo, allowedChatIds);
    const handler = (sharedMockClient.onDeleteMessage.add.mock.calls as any)[0][0];

    await handler({ channelId: null, messageIds: [2001] });

    expect(await repo.getRecent(-1, 10)).toHaveLength(1);
  });

  test("starting realtime sync twice removes the previous exact listeners", async () => {
    await startRealtimeSync(repo, allowedChatIds);
    const firstNewHandler = (sharedMockClient.onNewMessage.add.mock.calls as any)[0][0];
    const firstEditHandler = (sharedMockClient.onEditMessage.add.mock.calls as any)[0][0];
    const firstDeleteHandler = (sharedMockClient.onDeleteMessage.add.mock.calls as any)[0][0];

    await startRealtimeSync(repo, allowedChatIds);

    expect(sharedMockClient.onNewMessage.remove).toHaveBeenCalledWith(firstNewHandler);
    expect(sharedMockClient.onEditMessage.remove).toHaveBeenCalledWith(firstEditHandler);
    expect(sharedMockClient.onDeleteMessage.remove).toHaveBeenCalledWith(firstDeleteHandler);
  });

  test("failed client start removes all registered listeners", async () => {
    sharedMockClient.start = mock(() => Promise.reject(new Error("not authenticated")));

    const dispose = await startRealtimeSync(repo, allowedChatIds);

    expect(sharedMockClient.onNewMessage.remove.mock.calls).toHaveLength(1);
    expect(sharedMockClient.onEditMessage.remove.mock.calls).toHaveLength(1);
    expect(sharedMockClient.onDeleteMessage.remove.mock.calls).toHaveLength(1);
    expect(typeof dispose).toBe("function");
  });

  test("dispose removes listeners and prevents later writes", async () => {
    const dispose = await startRealtimeSync(repo, allowedChatIds);
    const handler = (sharedMockClient.onNewMessage.add.mock.calls as any)[0][0];

    dispose();
    await handler(highLevelMessage({ id: 3000, chatId: -1, text: "Too late" }));

    expect(sharedMockClient.onNewMessage.remove.mock.calls).toHaveLength(1);
    expect(await repo.getRecent(-1, 10)).toHaveLength(0);
  });
  test("shutdown removes listeners and closes the SDK client", async () => {
    sharedMockClient.destroy.mockClear();
    await startRealtimeSync(repo, allowedChatIds);
    await shutdownMtProto();
    expect(sharedMockClient.destroy).toHaveBeenCalledTimes(1);
    expect(sharedMockClient.onNewMessage.remove).toHaveBeenCalled();
    await shutdownMtProto();
    expect(sharedMockClient.destroy).toHaveBeenCalledTimes(1);
  });
  test("failed SDK destroy still releases the cached singleton", async () => {
    await startRealtimeSync(repo, allowedChatIds);
    sharedMockClient.destroy = mock(async () => {
      throw new Error("synthetic teardown failure");
    });
    await expect(shutdownMtProto()).rejects.toThrow("synthetic teardown failure");
    sharedMockClient.destroy = mock(() => Promise.resolve());
    await shutdownMtProto();
    expect(sharedMockClient.destroy).not.toHaveBeenCalled();
  });
});
