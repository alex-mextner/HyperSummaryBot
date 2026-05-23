import OpenAI from "openai";
import { loadConfig } from "../../config/env";

const DEFAULT_TIMEOUT_MS = 60_000;

let _zai: OpenAI | null = null;
let _hf: OpenAI | null = null;
let _gemini: OpenAI | null = null;
let _groq: OpenAI | null = null;

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

export function geminiClient(): OpenAI {
  if (!_gemini) {
    const config = loadConfig();
    _gemini = new OpenAI({
      apiKey: config.GEMINI_API_KEY,
      baseURL: config.GEMINI_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return _gemini;
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
