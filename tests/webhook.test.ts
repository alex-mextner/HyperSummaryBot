import { describe, test, expect } from "bun:test";
import "./setup";
import { startWebhookServer } from "../src/webhook-server";

describe("authenticated webhook boundary", () => {
  test("missing secret fails before accepting any request", () => {
    const old = process.env.WEBHOOK_SECRET;
    delete process.env.WEBHOOK_SECRET;
    process.env.WEBHOOK_URL = "https://example.invalid/webhook";
    process.env.TEST_API_PORT = "0";
    let server: ReturnType<typeof startWebhookServer> | undefined;
    try {
      expect(() => {
        server = startWebhookServer({ updates: { handleUpdate: async () => {} } });
      }).toThrow("WEBHOOK_SECRET");
    } finally {
      server?.stop(true);
      if (old === undefined) delete process.env.WEBHOOK_SECRET;
      else process.env.WEBHOOK_SECRET = old;
      delete process.env.WEBHOOK_URL;
      delete process.env.TEST_API_PORT;
    }
  });
  test("secret, update shape and bounded body are checked before dispatch", async () => {
    process.env.WEBHOOK_SECRET = "synthetic-webhook-secret";
    process.env.WEBHOOK_URL = "https://example.invalid/webhook";
    process.env.TEST_API_PORT = "0";
    let calls = 0;
    const server = startWebhookServer({
      updates: {
        handleUpdate: async () => {
          calls++;
        },
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/webhook`;
      expect(
        (await fetch(url, { method: "POST", body: JSON.stringify({ update_id: 1 }) })).status,
      ).toBe(401);
      expect(calls).toBe(0);
      const headers = { "x-telegram-bot-api-secret-token": "synthetic-webhook-secret" };
      expect(
        (await fetch(url, { method: "POST", headers, body: JSON.stringify({ update_id: "1" }) }))
          .status,
      ).toBe(400);
      expect(calls).toBe(0);
      expect(
        (await fetch(url, { method: "POST", headers, body: JSON.stringify({ update_id: 1 }) }))
          .status,
      ).toBe(200);
      await new Promise((r) => setTimeout(r, 5));
      expect(calls).toBe(1);
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ authenticatedWebhook: true });
    } finally {
      server.stop(true);
      delete process.env.WEBHOOK_SECRET;
      delete process.env.WEBHOOK_URL;
      delete process.env.TEST_API_PORT;
    }
  });
});
