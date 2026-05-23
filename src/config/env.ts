export interface EnvConfig {
  BOT_TOKEN: string;
  BOT_USERNAME: string;
  NODE_ENV: "development" | "production";
  DATABASE_PATH: string;

  // AI Primary — z.ai
  ZAI_API_KEY: string;
  ZAI_BASE_URL: string;
  ZAI_MODEL: string;
  ZAI_FAST_MODEL: string;

  // AI Fallback — HuggingFace
  HF_TOKEN: string;
  HF_BASE_URL: string;
  HF_MODEL: string;
  HF_FAST_MODEL: string;

  // AI Fallback — Gemini
  GEMINI_API_KEY: string;
  GEMINI_BASE_URL: string;
  GEMINI_MODEL: string;
  GEMINI_FAST_MODEL: string;

  // Optional — Groq
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  GROQ_FAST_MODEL?: string;

  // Notion (optional)
  NOTION_TOKEN?: string;

  // MTProto (optional — for history import before bot joined)
  MTPROTO_API_ID?: number;
  MTPROTO_API_HASH?: string;

  // Admin
  BOT_ADMIN_ID?: number;
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

export function loadConfig(): EnvConfig {
  return {
    BOT_TOKEN: requireEnv("BOT_TOKEN"),
    BOT_USERNAME: requireEnv("BOT_USERNAME"),
    NODE_ENV: (process.env.NODE_ENV as EnvConfig["NODE_ENV"]) || "development",
    DATABASE_PATH: process.env.DATABASE_PATH || "./data/hyper-summary.db",

    ZAI_API_KEY: requireEnv("ZAI_API_KEY"),
    ZAI_BASE_URL: requireEnv("ZAI_BASE_URL"),
    ZAI_MODEL: requireEnv("ZAI_MODEL"),
    ZAI_FAST_MODEL: requireEnv("ZAI_FAST_MODEL"),

    HF_TOKEN: requireEnv("HF_TOKEN"),
    HF_BASE_URL: requireEnv("HF_BASE_URL"),
    HF_MODEL: requireEnv("HF_MODEL"),
    HF_FAST_MODEL: requireEnv("HF_FAST_MODEL"),

    GEMINI_API_KEY: requireEnv("GEMINI_API_KEY"),
    GEMINI_BASE_URL: requireEnv("GEMINI_BASE_URL"),
    GEMINI_MODEL: requireEnv("GEMINI_MODEL"),
    GEMINI_FAST_MODEL: requireEnv("GEMINI_FAST_MODEL"),

    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_MODEL: process.env.GROQ_MODEL,
    GROQ_FAST_MODEL: process.env.GROQ_FAST_MODEL,

    NOTION_TOKEN: process.env.NOTION_TOKEN,

    MTPROTO_API_ID: process.env.MTPROTO_API_ID
      ? Number.parseInt(process.env.MTPROTO_API_ID, 10)
      : undefined,
    MTPROTO_API_HASH: process.env.MTPROTO_API_HASH,

    BOT_ADMIN_ID: process.env.BOT_ADMIN_ID
      ? Number.parseInt(process.env.BOT_ADMIN_ID, 10)
      : undefined,
    AI_DEBUG_LOGS: process.env.AI_DEBUG_LOGS === "true",

    WEBHOOK_URL: process.env.WEBHOOK_URL,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,

    TEST_API_PASSWORD: process.env.TEST_API_PASSWORD,
    TEST_API_PORT: process.env.TEST_API_PORT
      ? Number.parseInt(process.env.TEST_API_PORT, 10)
      : 3001,
  };
}
