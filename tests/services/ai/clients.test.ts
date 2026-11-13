import { describe, test, expect } from "bun:test";
import "../../setup";

import { claudeClient, zaiClient, hfClient, groqClient } from "../../../src/services/ai/clients";

describe("AI Clients", () => {
  test("Claude uses the configured API endpoint and no hidden retries", () => {
    const original = process.env.CLAUDE_API_TOKEN;
    try {
      process.env.CLAUDE_API_TOKEN = "test-claude-key";
      const client = claudeClient();
      expect(client.apiKey).toBe("test-claude-key");
      expect(client.baseURL).toBe("https://api.anthropic.com/v1/");
      expect(client.maxRetries).toBe(0);
      expect(claudeClient()).toBe(client);
      delete process.env.CLAUDE_API_TOKEN;
      expect(() => claudeClient()).toThrow("Claude client not configured");
    } finally {
      if (original === undefined) delete process.env.CLAUDE_API_TOKEN;
      else process.env.CLAUDE_API_TOKEN = original;
    }
  });
  test("zaiClient returns instance with correct config", () => {
    const client = zaiClient();
    expect(client).toBeDefined();
    expect((client as any).apiKey).toBe("test-zai-key");
    expect((client as any).baseURL).toBe("https://test.z.ai");
    expect((client as any).timeout).toBe(60000);
    expect((client as any).maxRetries).toBe(0);
  });

  test("zaiClient returns same instance (singleton)", () => {
    const a = zaiClient();
    const b = zaiClient();
    expect(a).toBe(b);
  });

  test("hfClient returns instance with correct config", () => {
    const client = hfClient();
    expect(client).toBeDefined();
    expect((client as any).apiKey).toBe("test-hf-token");
    expect((client as any).baseURL).toBe("https://test.hf.co");
  });

  test("groqClient returns instance when configured", () => {
    const client = groqClient();
    expect(client).toBeDefined();
    expect((client as any).apiKey).toBe("test-groq-key");
  });
});
