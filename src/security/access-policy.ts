export interface AccessPolicyConfig {
  ownerUserId?: number;
  allowedChatIds: readonly number[];
}

export interface AccessPolicy {
  readonly ownerUserId?: number;
  readonly allowedChatIds: ReadonlySet<number>;
  isConfigured(): boolean;
  isOwner(userId: number | undefined): boolean;
  isAllowedChat(chatId: number): boolean;
}

export function createAccessPolicy(config: AccessPolicyConfig): AccessPolicy {
  const allowedChatIds = new Set(config.allowedChatIds);
  const ownerUserId = config.ownerUserId;

  return {
    ownerUserId,
    allowedChatIds,
    isConfigured: () => ownerUserId !== undefined && allowedChatIds.size > 0,
    isOwner: (userId) => ownerUserId !== undefined && userId === ownerUserId,
    isAllowedChat: (chatId) => allowedChatIds.has(chatId),
  };
}
