import type OpenAI from "openai";
import { zaiClient, hfClient, geminiClient } from "./clients";

export interface StreamCallbacks {
  onTextDelta?: (text: string) => void;
  onToolCallStart?: (name: string, input: Record<string, unknown>) => void;
  onToolCallResult?: (name: string, result: unknown) => void;
}

export interface StreamRoundOptions {
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  maxTokens: number;
  temperature?: number;
  fast?: boolean;
  signal?: AbortSignal;
}

export interface StreamRoundResult {
  text: string;
  toolCalls: Array<{ name: string; arguments: string; id: string }>;
  assistantMessage: OpenAI.ChatCompletionMessageParam;
}

class EmptyProviderResponseError extends Error {
  constructor(provider: string) {
    super(`Provider ${provider} returned empty content`);
    this.name = "EmptyProviderResponseError";
  }
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof EmptyProviderResponseError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("rate limit") ||
      msg.includes("429") ||
      msg.includes("401") ||
      msg.includes("token expired") ||
      msg.includes("incorrect api key") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("network")
    );
  }
  return false;
}

interface ProviderSlot {
  name: string;
  client: () => OpenAI;
  model: string;
}

function buildChain(fast: boolean): ProviderSlot[] {
  const config = loadConfig();
  return [
    {
      name: "z.ai",
      client: zaiClient,
      model: fast ? config.ZAI_FAST_MODEL : config.ZAI_MODEL,
    },
    {
      name: "HF",
      client: hfClient,
      model: fast ? config.HF_FAST_MODEL : config.HF_MODEL,
    },
    {
      name: "Gemini",
      client: geminiClient,
      model: fast ? config.GEMINI_FAST_MODEL : config.GEMINI_MODEL,
    },
  ];
}

// Need to import config here for buildChain
import { loadConfig } from "../../config/env";

export async function aiStreamRound(
  options: StreamRoundOptions,
  callbacks: StreamCallbacks,
): Promise<StreamRoundResult> {
  const chain = buildChain(options.fast ?? false);
  let textEmitted = false;
  const fullText = { current: "" };
  const toolCalls: Array<{ name: string; arguments: string; id: string }> = [];

  const wrappedCallbacks: StreamCallbacks = {
    onTextDelta: (text) => {
      textEmitted = true;
      fullText.current += text;
      callbacks.onTextDelta?.(text);
    },
    onToolCallStart: callbacks.onToolCallStart,
    onToolCallResult: callbacks.onToolCallResult,
  };

  for (const slot of chain) {
    try {
      const result = await streamFromProvider(slot, options, wrappedCallbacks, fullText, toolCalls);
      return result;
    } catch (error) {
      if (textEmitted) throw error;
      if (isRetryableError(error)) {
        console.warn(`Provider ${slot.name} failed, trying next...`, error);
        continue;
      }
      throw error;
    }
  }

  throw new Error("All AI providers failed");
}

async function streamFromProvider(
  slot: ProviderSlot,
  options: StreamRoundOptions,
  callbacks: StreamCallbacks,
  fullText: { current: string },
  toolCalls: Array<{ name: string; arguments: string; id: string }>,
): Promise<StreamRoundResult> {
  const client = slot.client();
  const stream = await client.chat.completions.create(
    {
      model: slot.model,
      messages: options.messages,
      tools: options.tools,
      max_tokens: options.maxTokens,
      temperature: options.temperature ?? 0.7,
      stream: true,
    },
    { signal: options.signal },
  );

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;

    // Handle z.ai quirk: content='' with only reasoning_content
    if (
      delta?.content === "" &&
      !delta?.tool_calls &&
      (delta as Record<string, unknown>)?.reasoning_content
    ) {
      throw new EmptyProviderResponseError(slot.name);
    }

    if (delta?.content) {
      callbacks.onTextDelta?.(delta.content);
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const existing = toolCalls[tc.index ?? 0];
        if (existing) {
          existing.arguments += tc.function?.arguments ?? "";
        } else if (tc.function?.name) {
          toolCalls[tc.index ?? 0] = {
            name: tc.function.name,
            arguments: tc.function.arguments ?? "",
            id: tc.id ?? `call_${Date.now()}`,
          };
        }
      }
    }
  }

  const assistantMessage: OpenAI.ChatCompletionMessageParam = {
    role: "assistant",
    content: fullText.current,
    tool_calls:
      toolCalls.length > 0
        ? toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          }))
        : undefined,
  };

  return {
    text: fullText.current,
    toolCalls,
    assistantMessage,
  };
}
