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

  console.log(
    `[ai] Round start — chain=${chain.map((s) => s.name).join(", ")}, messages=${options.messages.length}, max_tokens=${options.maxTokens}`,
  );
  for (const slot of chain) {
    try {
      const result = await streamFromProvider(slot, options, wrappedCallbacks, fullText, toolCalls);
      console.log(`[ai] Round complete via ${slot.name} — ${result.text.length} chars`);
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const status = (error as any)?.status ?? "no-status";
      // Partial output recovery: if we got some text but the model died,
      // and output is very short, treat as retryable and ask next model to continue.
      if (textEmitted && fullText.current.length < 500) {
        console.warn(
          `[ai] ${slot.name} PARTIAL FAILURE (${fullText.current.length} chars) — trying next provider with continuation context...`,
        );
        // Inject partial output as an assistant message so next model can continue
        options.messages = [
          ...options.messages,
          { role: "assistant", content: fullText.current },
          {
            role: "user",
            content: "Продолжи с того места, где оборвался текст выше. Допиши оставшиеся секции.",
          },
        ];
        fullText.current = ""; // reset accumulator for next model
        continue;
      }
      if (textEmitted) {
        console.error(
          `[ai] ${slot.name} FAILED after text already emitted — aborting round. status=${status}, error=${msg}`,
        );
        throw error;
      }
      if (isRetryableError(error)) {
        console.warn(
          `[ai] ${slot.name} FAILED (retryable) — status=${status}, error=${msg}. Trying next...`,
        );
        continue;
      }
      console.error(`[ai] ${slot.name} FAILED (non-retryable) — status=${status}, error=${msg}`);
      throw error;
    }
  }

  console.error(`[ai] All ${chain.length} providers failed`);
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
  console.log(
    `[ai] Streaming from ${slot.name}, model=${slot.model}, max_tokens=${options.maxTokens}`,
  );
  const start = Date.now();

  let stream;
  try {
    stream = await client.chat.completions.create(
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
  } catch (err) {
    const elapsed = Date.now() - start;
    const status = (err as any)?.status ?? "unknown";
    const msg = (err as Error)?.message ?? String(err);
    console.error(
      `[ai] ${slot.name} stream init FAILED after ${elapsed}ms — status=${status}, message=${msg}`,
    );
    throw err;
  }

  let chunks = 0;
  for await (const chunk of stream) {
    chunks++;
    const delta = chunk.choices[0]?.delta;

    // Handle z.ai quirk: content='' with only reasoning_content
    if (
      delta?.content === "" &&
      !delta?.tool_calls &&
      (delta as Record<string, unknown>)?.reasoning_content
    ) {
      console.warn(
        `[ai] ${slot.name} returned empty content with reasoning_content only — treating as empty response`,
      );
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

  const elapsed = Date.now() - start;
  console.log(
    `[ai] ${slot.name} stream COMPLETE — ${chunks} chunks, ${fullText.current.length} chars, ${elapsed}ms`,
  );

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
