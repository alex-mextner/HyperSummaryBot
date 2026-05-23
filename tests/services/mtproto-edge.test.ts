import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase } from "../../src/db/client";
import { createTestSchema } from "../helpers/db-schema";
import { ChatHistoryRepository } from "../../src/db/repositories/chat-history";

// Ensure env vars required by loadConfig() are present
process.env.BOT_TOKEN = process.env.BOT_TOKEN || "test-bot";
process.env.BOT_USERNAME = process.env.BOT_USERNAME || "test_bot";
process.env.ZAI_API_KEY = process.env.ZAI_API_KEY || "test";
process.env.ZAI_BASE_URL = process.env.ZAI_BASE_URL || "https://test";
process.env.ZAI_MODEL = process.env.ZAI_MODEL || "test";
process.env.ZAI_FAST_MODEL = process.env.ZAI_FAST_MODEL || "test";
process.env.HF_TOKEN = process.env.HF_TOKEN || "test";
process.env.HF_BASE_URL = process.env.HF_BASE_URL || "https://test";
process.env.HF_MODEL = process.env.HF_MODEL || "test";
process.env.HF_FAST_MODEL = process.env.HF_FAST_MODEL || "test";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test";
process.env.GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || "https://test";
process.env.GEMINI_MODEL = process.env.GEMINI_MODEL || "test";
process.env.GEMINI_FAST_MODEL = process.env.GEMINI_FAST_MODEL || "test";

// Save original env values
const ORIGINAL_API_ID = process.env.MTPROTO_API_ID;
const ORIGINAL_API_HASH = process.env.MTPROTO_API_HASH;

describe("MTProto not configured edge case", () => {
  let db: Database;
  let repo: ChatHistoryRepository;

  beforeEach(() => {
    delete process.env.MTPROTO_API_ID;
    delete process.env.MTPROTO_API_HASH;
    db = initDatabase(":memory:");
    createTestSchema(db);
    repo = new ChatHistoryRepository(db);
  });

  afterEach(() => {
    if (ORIGINAL_API_ID !== undefined) process.env.MTPROTO_API_ID = ORIGINAL_API_ID;
    else delete process.env.MTPROTO_API_ID;
    if (ORIGINAL_API_HASH !== undefined) process.env.MTPROTO_API_HASH = ORIGINAL_API_HASH;
    else delete process.env.MTPROTO_API_HASH;
  });

  test("importChatHistory throws when config is missing", async () => {
    const { importChatHistory } = await import("../../src/services/mtproto");
    await expect(importChatHistory(repo, 1, { limit: 10 })).rejects.toThrow(
      "MTProto not configured",
    );
  });

  test("isMtProtoConfigured returns false", async () => {
    const { isMtProtoConfigured } = await import("../../src/services/mtproto");
    expect(await isMtProtoConfigured()).toBe(false);
  });
});
