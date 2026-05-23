import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, requireEnv } from "../../src/config/env";

describe("requireEnv", () => {
  test("returns value when set", () => {
    process.env.TEST_VAR_REQ = "hello";
    expect(requireEnv("TEST_VAR_REQ")).toBe("hello");
  });

  test("throws when missing", () => {
    delete process.env.MISSING_VAR_XYZ;
    expect(() => requireEnv("MISSING_VAR_XYZ")).toThrow(
      "MISSING_VAR_XYZ environment variable is required",
    );
  });
});

describe("loadConfig", () => {
  const snapshot: Record<string, string | undefined> = {};

  const keys = [
    "BOT_TOKEN",
    "BOT_USERNAME",
    "NODE_ENV",
    "DATABASE_PATH",
    "ZAI_API_KEY",
    "ZAI_BASE_URL",
    "ZAI_MODEL",
    "ZAI_FAST_MODEL",
    "HF_TOKEN",
    "HF_BASE_URL",
    "HF_MODEL",
    "HF_FAST_MODEL",
    "GEMINI_API_KEY",
    "GEMINI_BASE_URL",
    "GEMINI_MODEL",
    "GEMINI_FAST_MODEL",
    "GROQ_API_KEY",
    "GROQ_MODEL",
    "GROQ_FAST_MODEL",
    "MTPROTO_API_ID",
    "MTPROTO_API_HASH",
    "NOTION_TOKEN",
    "NOTION_DATABASE_ID",
    "BOT_ADMIN_ID",
    "AI_DEBUG_LOGS",
  ];

  beforeEach(() => {
    for (const k of keys) {
      snapshot[k] = process.env[k];
    }
    // Ensure required vars are present
    process.env.BOT_TOKEN = "bot-token";
    process.env.BOT_USERNAME = "testbot";
    process.env.NODE_ENV = "development";
    process.env.ZAI_API_KEY = "zai-key";
    process.env.ZAI_BASE_URL = "https://z.ai";
    process.env.ZAI_MODEL = "zai-model";
    process.env.ZAI_FAST_MODEL = "zai-fast";
    process.env.HF_TOKEN = "hf-token";
    process.env.HF_BASE_URL = "https://hf.co";
    process.env.HF_MODEL = "hf-model";
    process.env.HF_FAST_MODEL = "hf-fast";
    process.env.GEMINI_API_KEY = "gem-key";
    process.env.GEMINI_BASE_URL = "https://gemini";
    process.env.GEMINI_MODEL = "gem-model";
    process.env.GEMINI_FAST_MODEL = "gem-fast";
  });

  afterEach(() => {
    for (const k of keys) {
      if (snapshot[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = snapshot[k];
      }
    }
  });

  test("returns full config with required fields", () => {
    const config = loadConfig();
    expect(config.BOT_TOKEN).toBe("bot-token");
    expect(config.BOT_USERNAME).toBe("testbot");
    expect(config.NODE_ENV).toBe("development");
    expect(config.DATABASE_PATH).toBe("./data/hyper-summary.db");
    expect(config.ZAI_API_KEY).toBe("zai-key");
    expect(config.ZAI_BASE_URL).toBe("https://z.ai");
    expect(config.ZAI_MODEL).toBe("zai-model");
  });

  test("reads NODE_ENV and DATABASE_PATH from env", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_PATH = "/tmp/test.db";
    const config = loadConfig();
    expect(config.NODE_ENV).toBe("production");
    expect(config.DATABASE_PATH).toBe("/tmp/test.db");
  });

  test("parses optional numeric fields", () => {
    process.env.MTPROTO_API_ID = "12345";
    process.env.BOT_ADMIN_ID = "98765";
    const config = loadConfig();
    expect(config.MTPROTO_API_ID).toBe(12345);
    expect(config.BOT_ADMIN_ID).toBe(98765);
  });

  test("parses AI_DEBUG_LOGS boolean", () => {
    process.env.AI_DEBUG_LOGS = "true";
    const config = loadConfig();
    expect(config.AI_DEBUG_LOGS).toBe(true);
  });

  test("sets AI_DEBUG_LOGS to false by default", () => {
    delete process.env.AI_DEBUG_LOGS;
    const config = loadConfig();
    expect(config.AI_DEBUG_LOGS).toBe(false);
  });

  test("sets optional Groq fields", () => {
    process.env.GROQ_API_KEY = "groq-key";
    process.env.GROQ_MODEL = "groq-model";
    process.env.GROQ_FAST_MODEL = "groq-fast";
    const config = loadConfig();
    expect(config.GROQ_API_KEY).toBe("groq-key");
    expect(config.GROQ_MODEL).toBe("groq-model");
    expect(config.GROQ_FAST_MODEL).toBe("groq-fast");
  });

  test("sets optional Notion fields", () => {
    process.env.NOTION_TOKEN = "ntoken";
    process.env.NOTION_DATABASE_ID = "ndb";
    const config = loadConfig();
    expect(config.NOTION_TOKEN).toBe("ntoken");
    expect(config.NOTION_DATABASE_ID).toBe("ndb");
  });

  test("sets optional MTProto fields", () => {
    process.env.MTPROTO_API_ID = "999";
    process.env.MTPROTO_API_HASH = "hash";
    const config = loadConfig();
    expect(config.MTPROTO_API_ID).toBe(999);
    expect(config.MTPROTO_API_HASH).toBe("hash");
  });
});
