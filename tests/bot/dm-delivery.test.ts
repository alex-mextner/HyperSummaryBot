import { describe, expect, mock, test } from "bun:test";
import { deliverDmText, requireDmDelivery, sendDmText } from "../../src/bot/dm-delivery";

function makeContext(type: string = "group") {
  return {
    chat: { type },
    reply: mock(async (_text: string) => true),
  };
}

describe("DM delivery gateway", () => {
  test("preflights the numeric recipient without posting in the group", async () => {
    const sendChatAction = mock(async () => true);
    const bot = { api: { sendChatAction, sendMessage: mock(async () => true) } };
    const ctx = makeContext();

    expect(await requireDmDelivery(bot, ctx, 42)).toBe(true);
    expect(sendChatAction).toHaveBeenCalledWith({ chat_id: 42, action: "typing" });
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  test("blocked DM yields only a neutral group hint", async () => {
    const bot = {
      api: {
        sendChatAction: mock(async () => Promise.reject(new Error("Forbidden"))),
        sendMessage: mock(async () => true),
      },
    };
    const ctx = makeContext("supergroup");

    expect(await requireDmDelivery(bot, ctx, 42)).toBe(false);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const hint = String(ctx.reply.mock.calls[0]?.[0] ?? "");
    expect(hint).toContain("Открой личный чат");
    expect(hint).not.toContain("Forbidden");
  });

  test("blocked DM does not try to echo a fallback into the same private chat", async () => {
    const bot = {
      api: {
        sendChatAction: mock(async () => Promise.reject(new Error("Forbidden"))),
        sendMessage: mock(async () => true),
      },
    };
    const ctx = makeContext("private");

    expect(await requireDmDelivery(bot, ctx, 42)).toBe(false);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  test("a send failure after preflight never falls back with private content", async () => {
    const bot = {
      api: {
        sendChatAction: mock(async () => true),
        sendMessage: mock(async () => Promise.reject(new Error("Forbidden"))),
      },
    };
    const ctx = makeContext("group");

    expect(await deliverDmText(bot, ctx, 42, "SECRET RESULT")).toBe(false);
    const hint = String(ctx.reply.mock.calls[0]?.[0] ?? "");
    expect(hint).toContain("Открой личный чат");
    expect(hint).not.toContain("SECRET RESULT");
  });

  test("sendDmText never redirects to the source chat", async () => {
    const sendMessage = mock(async () => true);
    const bot = { api: { sendChatAction: mock(async () => true), sendMessage } };

    await sendDmText(bot, 42, "private result");

    expect(sendMessage).toHaveBeenCalledWith({ chat_id: 42, text: "private result" });
  });
});
