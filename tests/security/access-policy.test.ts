import { describe, expect, test } from "bun:test";
import { createAccessPolicy } from "../../src/security/access-policy";

describe("access policy", () => {
  test("denies everything when owner or allowlist is missing", () => {
    const policy = createAccessPolicy({ allowedChatIds: [] });

    expect(policy.isConfigured()).toBe(false);
    expect(policy.isOwner(1)).toBe(false);
    expect(policy.isAllowedChat(-1001)).toBe(false);
  });

  test("allows only the configured owner and source chats", () => {
    const policy = createAccessPolicy({ ownerUserId: 42, allowedChatIds: [-1001, -2] });

    expect(policy.isConfigured()).toBe(true);
    expect(policy.isOwner(42)).toBe(true);
    expect(policy.isOwner(7)).toBe(false);
    expect(policy.isAllowedChat(-1001)).toBe(true);
    expect(policy.isAllowedChat(-2)).toBe(true);
    expect(policy.isAllowedChat(-3)).toBe(false);
  });
});
