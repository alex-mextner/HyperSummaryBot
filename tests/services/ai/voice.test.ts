import { describe, test, expect } from "bun:test";
import "../../setup";

import { groqClient } from "../../../src/services/ai/clients";
import { transcribeAudio } from "../../../src/services/ai/voice";

describe("transcribeAudio", () => {
  test("returns transcribed text and language", async () => {
    const client = groqClient();
    const originalCreate = (client as any).audio.transcriptions.create;
    (client as any).audio.transcriptions.create = async () => ({
      text: "Hello world",
      language: "en",
    });

    const result = await transcribeAudio(new ArrayBuffer(8));
    expect(result.text).toBe("Hello world");
    expect(result.language).toBe("en");

    (client as any).audio.transcriptions.create = originalCreate;
  });

  test("returns text without language when missing", async () => {
    const client = groqClient();
    const originalCreate = (client as any).audio.transcriptions.create;
    (client as any).audio.transcriptions.create = async () => ({ text: "Just text" });

    const result = await transcribeAudio(new ArrayBuffer(8));
    expect(result.text).toBe("Just text");
    expect(result.language).toBeUndefined();

    (client as any).audio.transcriptions.create = originalCreate;
  });

  test("propagates errors from the API", async () => {
    const client = groqClient();
    const originalCreate = (client as any).audio.transcriptions.create;
    (client as any).audio.transcriptions.create = async () => {
      throw new Error("API failure");
    };

    await expect(transcribeAudio(new ArrayBuffer(8))).rejects.toThrow("API failure");

    (client as any).audio.transcriptions.create = originalCreate;
  });
});
