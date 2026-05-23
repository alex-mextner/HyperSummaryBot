import { describe, test, expect } from "bun:test";
import {
  buildMessageContent,
  buildForwardFromNameForDb,
  parseSummaryArgs,
  parseSearchQuery,
  parseAskQuestion,
  formatChatStatsText,
} from "../../src/bot/message-processor";

describe("buildMessageContent", () => {
  test("returns plain text by default", () => {
    const result = buildMessageContent({ text: "Hello world" });
    expect(result).toBe("Hello world");
  });

  test("uses caption when text is missing", () => {
    const result = buildMessageContent({ caption: "Photo caption" });
    expect(result).toBe("Photo caption");
  });

  test("returns empty string when no content", () => {
    const result = buildMessageContent({});
    expect(result).toBe("");
  });

  test("voice placeholder overrides text", () => {
    const result = buildMessageContent({ text: "Hello", voice: true });
    expect(result).toBe("[Voice message - transcribing...]");
  });

  test("adds forward enrichment", () => {
    const result = buildMessageContent({
      text: "Check this",
      forwardOrigin: { type: "user", senderUser: { firstName: "Alice" } },
    });
    expect(result).toBe("Forwarded from Alice: Check this");
  });

  test("adds reply enrichment", () => {
    const result = buildMessageContent({
      text: "Agreed",
      replyMessage: {
        text: "Let's meet at 5",
        from: { firstName: "Bob" },
      },
    });
    expect(result).toBe("Reply to Bob («Let's meet at 5...»): Agreed");
  });

  test("combines forward and reply enrichment", () => {
    const result = buildMessageContent({
      text: "Nice",
      forwardOrigin: { type: "user", senderUser: { firstName: "Alice" } },
      replyMessage: {
        text: "Original post",
        from: { firstName: "Bob" },
      },
    });
    expect(result).toContain("Forwarded from Alice:");
    expect(result).toContain("Reply to Bob");
  });

  test("uses 'User' when reply sender has no name", () => {
    const result = buildMessageContent({
      text: "Yes",
      replyMessage: { text: "Question" },
    });
    expect(result).toContain("Reply to User");
  });

  test("truncates long reply text", () => {
    const longText = "A".repeat(200);
    const result = buildMessageContent({
      text: "OK",
      replyMessage: { text: longText },
    });
    expect(result).toContain(longText.slice(0, 100));
  });
});

describe("buildForwardFromNameForDb", () => {
  test("returns user firstName for user forward", () => {
    const result = buildForwardFromNameForDb({
      type: "user",
      senderUser: { firstName: "Alice" },
    });
    expect(result).toBe("Alice");
  });

  test("returns chat title for chat forward", () => {
    const result = buildForwardFromNameForDb({
      type: "chat",
      senderChat: { title: "Dev Chat" },
    });
    expect(result).toBe("Dev Chat");
  });

  test("returns null for hidden_user forward", () => {
    const result = buildForwardFromNameForDb({ type: "hidden_user" });
    expect(result).toBeNull();
  });

  test("returns null when no forward origin", () => {
    const result = buildForwardFromNameForDb(undefined);
    expect(result).toBeNull();
  });
});

describe("parseSummaryArgs", () => {
  test("parses default values", () => {
    const result = parseSummaryArgs("/summary");
    expect(result.type).toBe("general");
    expect(result.count).toBe(50);
  });

  test("parses type and count", () => {
    const result = parseSummaryArgs("/summary action_items 30");
    expect(result.type).toBe("action_items");
    expect(result.count).toBe(30);
  });

  test("caps count at 200", () => {
    const result = parseSummaryArgs("/summary general 999");
    expect(result.count).toBe(200);
  });
});

describe("parseSearchQuery", () => {
  test("extracts query after command", () => {
    const result = parseSearchQuery("/search hello world");
    expect(result).toBe("hello world");
  });

  test("returns empty string for bare command", () => {
    const result = parseSearchQuery("/search");
    expect(result).toBe("");
  });
});

describe("parseAskQuestion", () => {
  test("extracts question after command", () => {
    const result = parseAskQuestion("/ask what is this");
    expect(result).toBe("what is this");
  });

  test("returns empty string for bare command", () => {
    const result = parseAskQuestion("/ask");
    expect(result).toBe("");
  });
});

describe("formatChatStatsText", () => {
  test("formats chat stats correctly", () => {
    const result = formatChatStatsText({
      chatName: "Test Chat",
      total: 150,
      percentage: "15.0",
      earliest: "01.01.2024",
      latest: "23.05.2024",
    });
    expect(result).toContain("Test Chat");
    expect(result).toContain("150 сообщений");
    expect(result).toContain("15.0%");
    expect(result).toContain("01.01.2024");
    expect(result).toContain("23.05.2024");
  });
});
