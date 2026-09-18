import { test, expect } from "bun:test";
import { sourceDate, sameChatReplyId } from "../../src/utils/source-metadata";
import { formatMessagesForPrompt } from "../../src/utils/message-formatter";
test("missing dates stay unknown, Telegram seconds are explicit", () => {
  expect(sourceDate(undefined)).toBeNull();
  expect(sourceDate(null)).toBeNull();
  expect(sourceDate(1700000000)?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
  expect(() => sourceDate("yesterday")).toThrow();
  expect(() => sourceDate(NaN)).toThrow();
});
test("cross-chat reply IDs cannot become same-chat citations", () => {
  expect(sameChatReplyId(4, "other_chat")).toBeNull();
  expect(sameChatReplyId(4, "same_chat")).toBe(4);
});
test("prompt carries source date and thread, not a raw user ID fallback", () => {
  const text = formatMessagesForPrompt([
    {
      userId: 123456789,
      userName: null,
      content: "Hi",
      messageId: 5,
      sourceCreatedAt: new Date("2026-01-01T00:00:00Z"),
      replyToMessageId: 4,
      threadId: 3,
    },
  ]).text;
  expect(text).toContain("date=2026-01-01");
  expect(text).toContain("reply_to=4");
  expect(text).toContain("thread=3");
  expect(text).not.toContain("123456789");
});

test("high-level SDK Date values remain authoritative", () => {
  const value = new Date("2026-01-01T12:00:00Z");
  expect(sourceDate(value)?.toISOString()).toBe(value.toISOString());
});
