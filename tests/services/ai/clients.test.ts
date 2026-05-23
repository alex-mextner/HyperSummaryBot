import { describe, test, expect } from "bun:test";
import "../../setup";

import { zaiClient, hfClient, geminiClient, groqClient } from "../../../src/services/ai/clients";

describe("AI Clients", () => {
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

  test("geminiClient returns instance with correct config", () => {
    const client = geminiClient();
    expect(client).toBeDefined();
    expect((client as any).apiKey).toBe("test-gem-key");
    expect((client as any).baseURL).toBe("https://test.gemini");
  });

  test("groqClient returns instance when configured", () => {
    const client = groqClient();
    expect(client).toBeDefined();
    expect((client as any).apiKey).toBe("test-groq-key");
  });
});
