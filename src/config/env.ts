export interface EnvConfig {
  BOT_TOKEN: string;
  BOT_USERNAME: string;
  NODE_ENV: "development" | "production";
  DATABASE_PATH: string;

  // AI Primary — Claude
  CLAUDE_API_TOKEN?: string;
  CLAUDE_API_TOKEN2?: string;
  CLAUDE_BASE_URL: string;
  CLAUDE_MODEL: string;
  CLAUDE_FAST_MODEL: string;

  // AI Fallback — z.ai
  ZAI_API_KEY: string;
  ZAI_BASE_URL: string;
  ZAI_MODEL: string;
  ZAI_FAST_MODEL: string;

  // AI Fallback — HuggingFace
  HF_TOKEN: string;
  HF_BASE_URL: string;
  HF_MODEL: string;
  HF_FAST_MODEL: string;

  // Optional — Groq
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  GROQ_FAST_MODEL?: string;

  // Notion (optional)
  NOTION_TOKEN?: string;

  // MTProto (optional — for history import before bot joined)
  MTPROTO_API_ID?: number;
  MTPROTO_API_HASH?: string;
  MTPROTO_SESSION_PATH: string;

  // Admin
  BOT_ADMIN_ID?: number;
  ALLOWED_CHAT_IDS: number[];
  AI_DEBUG_LOGS: boolean;

  // Webhook (optional — alternative to polling)
  WEBHOOK_URL?: string;
  WEBHOOK_SECRET?: string;

  // Test API (protected endpoint for debugging)
  TEST_API_PASSWORD?: string;
  TEST_API_PORT: number;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

export function parseChatIdList(value: string | undefined): number[] {
  if (!value?.trim()) return [];
  return value.split(",").map((part) => {
    const raw = part.trim();
    const id = Number(raw);
    if (!raw || !Number.isSafeInteger(id) || id === 0) {
      throw new Error(`Invalid chat ID in ALLOWED_CHAT_IDS: ${raw || "<empty>"}`);
    }
    return id;
  });
}

export function parseOwnerUserId(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const id = Number(value.trim());
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("BOT_ADMIN_ID must be a positive safe integer");
  }
  return id;
}

export function loadConfig(): EnvConfig {
  return {
    BOT_TOKEN: requireEnv("BOT_TOKEN"),
    BOT_USERNAME: requireEnv("BOT_USERNAME"),
    NODE_ENV: (process.env.NODE_ENV as EnvConfig["NODE_ENV"]) || "development",
    DATABASE_PATH: process.env.DATABASE_PATH || "./data/hyper-summary.db",

    CLAUDE_API_TOKEN: process.env.CLAUDE_API_TOKEN?.trim() || undefined,
    CLAUDE_API_TOKEN2: process.env.CLAUDE_API_TOKEN2?.trim() || undefined,
    CLAUDE_BASE_URL: process.env.CLAUDE_BASE_URL || "https://api.anthropic.com/v1/",
    CLAUDE_MODEL: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
    CLAUDE_FAST_MODEL: process.env.CLAUDE_FAST_MODEL || "claude-haiku-5-5",

    ZAI_API_KEY: requireEnv("ZAI_API_KEY"),
    ZAI_BASE_URL: requireEnv("ZAI_BASE_URL"),
    ZAI_MODEL: requireEnv("ZAI_MODEL"),
    ZAI_FAST_MODEL: requireEnv("ZAI_FAST_MODEL"),

    HF_TOKEN: requireEnv("HF_TOKEN"),
    HF_BASE_URL: requireEnv("HF_BASE_URL"),
    HF_MODEL: requireEnv("HF_MODEL"),
    HF_FAST_MODEL: requireEnv("HF_FAST_MODEL"),

    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_MODEL: process.env.GROQ_MODEL,
    GROQ_FAST_MODEL: process.env.GROQ_FAST_MODEL,

    NOTION_TOKEN: process.env.NOTION_TOKEN,

    MTPROTO_API_ID: process.env.MTPROTO_API_ID
      ? Number.parseInt(process.env.MTPROTO_API_ID, 10)
      : undefined,
    MTPROTO_API_HASH: process.env.MTPROTO_API_HASH,
    MTPROTO_SESSION_PATH: process.env.MTPROTO_SESSION_PATH || "data/mtcute-session",

    BOT_ADMIN_ID: parseOwnerUserId(process.env.BOT_ADMIN_ID),
    ALLOWED_CHAT_IDS: parseChatIdList(process.env.ALLOWED_CHAT_IDS),
    AI_DEBUG_LOGS: process.env.AI_DEBUG_LOGS === "true",

    WEBHOOK_URL: process.env.WEBHOOK_URL,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,

    TEST_API_PASSWORD: process.env.TEST_API_PASSWORD,
    TEST_API_PORT: process.env.TEST_API_PORT
      ? Number.parseInt(process.env.TEST_API_PORT, 10)
      : 3003,
  };
}
