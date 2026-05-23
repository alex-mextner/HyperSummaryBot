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

  test("uses 'User' for user forward without name", () => {
    const result = buildMessageContent({
      text: "Anon",
      forwardOrigin: { type: "user" },
    });
    expect(result).toBe("Forwarded from User: Anon");
  });

  test("uses chat title for chat forward", () => {
    const result = buildMessageContent({
      text: "Group msg",
      forwardOrigin: { type: "chat", senderChat: { title: "Dev Chat" } },
    });
    expect(result).toBe("Forwarded from Dev Chat: Group msg");
  });

  test("uses 'Chat' for chat forward without title", () => {
    const result = buildMessageContent({
      text: "Untitled",
      forwardOrigin: { type: "chat" },
    });
    expect(result).toBe("Forwarded from Chat: Untitled");
  });

  test("uses 'Forwarded message' for hidden_user forward", () => {
    const result = buildMessageContent({
      text: "Secret",
      forwardOrigin: { type: "hidden_user" },
    });
    expect(result).toBe("Forwarded from Forwarded message: Secret");
  });

  test("uses 'Forwarded message' for channel forward", () => {
    const result = buildMessageContent({
      text: "News",
      forwardOrigin: { type: "channel", senderChat: { title: "Tech News" } },
    });
    expect(result).toBe("Forwarded from Forwarded message: News");
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

  test("returns null for channel forward", () => {
    const result = buildForwardFromNameForDb({
      type: "channel",
      senderChat: { title: "News" },
    });
    expect(result).toBeNull();
  });

  test("returns null for supergroup forward", () => {
    const result = buildForwardFromNameForDb({
      type: "supergroup",
      senderChat: { title: "Group" },
    });
    expect(result).toBeNull();
  });

  test("returns null when no forward origin", () => {
    const result = buildForwardFromNameForDb(undefined);
    expect(result).toBeNull();
  });
});

describe("parseSummaryArgs", () => {
  test("parses empty hint", () => {
    const result = parseSummaryArgs("/summary");
    expect(result.hint).toBe("");
  });

  test("parses hint text", () => {
    const result = parseSummaryArgs("/summary focus on decisions");
    expect(result.hint).toBe("focus on decisions");
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
