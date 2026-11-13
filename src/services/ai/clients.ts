import OpenAI from "openai";
import { loadConfig } from "../../config/env";
import { createLogger } from "../../utils/logger";

const aiLogger = createLogger("ai-clients");

const DEFAULT_TIMEOUT_MS = 60_000;

let _claudeClients: OpenAI[] = [];
let _zai: OpenAI | null = null;
let _hf: OpenAI | null = null;
let _groq: OpenAI | null = null;

export function claudeClients(): OpenAI[] {
  const config = loadConfig();
  const tokens = [...new Set(
    [config.CLAUDE_API_TOKEN, config.CLAUDE_API_TOKEN2].filter((token): token is string => !!token),
  )];
  _claudeClients = tokens.map((apiKey) =>
    _claudeClients.find((client) => client.apiKey === apiKey && client.baseURL === config.CLAUDE_BASE_URL) ??
    new OpenAI({ apiKey, baseURL: config.CLAUDE_BASE_URL, timeout: DEFAULT_TIMEOUT_MS, maxRetries: 0 }),
  );
  return _claudeClients;
}

export function claudeClient(): OpenAI {
  const client = claudeClients()[0];
  if (!client) throw new Error("Claude client not configured");
  return client;
}

export function isClaudeCreditBalanceError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 400 &&
    "message" in error && typeof error.message === "string" && /credit balance is too low/i.test(error.message);
}

/** Rotate credentials only while opening a stream, under the caller's deadline. */
export async function withClaudeCredentials<T>(
  request: (client: OpenAI) => PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  const clients = claudeClients();
  for (const [index, client] of clients.entries()) {
    signal.throwIfAborted();
    try {
      return await request(client);
    } catch (error) {
      signal.throwIfAborted();
      const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      if (
        typeof status !== "number" ||
        (![401, 402, 403, 429].includes(status) && !isClaudeCreditBalanceError(error)) ||
        index + 1 === clients.length
      ) throw error;
      aiLogger.warn({ provider: "Claude", status, credential: index + 1 }, "Claude credential unavailable; trying backup");
    }
  }
  throw new Error("Claude client not configured");
}

export function zaiClient(): OpenAI {
  if (!_zai) {
    const config = loadConfig();
    _zai = new OpenAI({
      apiKey: config.ZAI_API_KEY,
      baseURL: config.ZAI_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return _zai;
}

export function hfClient(): OpenAI {
  if (!_hf) {
    const config = loadConfig();
    _hf = new OpenAI({
      apiKey: config.HF_TOKEN,
      baseURL: config.HF_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return _hf;
}

export function groqClient(): OpenAI {
  const config = loadConfig();
  if (!config.GROQ_API_KEY) {
    _groq = null;
    throw new Error("Groq client not configured");
  }
  if (!_groq) {
    _groq = new OpenAI({
      apiKey: config.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return _groq;
}
