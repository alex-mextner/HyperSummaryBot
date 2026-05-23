/** Message formatting utilities for AI prompts */

export interface UserLookup {
  /** Map of userId → display name for AI prompt */
  names: Map<number, string>;
  /** Raw entries for building the lookup section */
  entries: Array<{ userId: number; name: string; username?: string | null }>;
}

/** Build a user lookup dictionary from messages.
 *  Prefers @username, falls back to firstName, then "User N". */
export function buildUserLookup(
  messages: Array<{ userId: number; userName: string | null }>,
): UserLookup {
  const seen = new Set<number>();
  const entries: Array<{ userId: number; name: string; username?: string | null }> = [];

  for (const msg of messages) {
    if (seen.has(msg.userId)) continue;
    seen.add(msg.userId);

    let display: string;
    if (msg.userName?.startsWith("@")) {
      display = msg.userName;
    } else if (msg.userName && msg.userName.length > 0 && msg.userName !== "null") {
      display = msg.userName;
    } else {
      display = `User_${msg.userId}`;
    }

    entries.push({ userId: msg.userId, name: display });
  }

  const names = new Map<number, string>();
  for (const e of entries) {
    names.set(e.userId, e.name);
  }

  return { names, entries };
}

/** Format messages for AI prompt with names only.
 *  Raw userId is NEVER exposed to the AI. */
export function formatMessagesForPrompt(
  messages: Array<{ userId: number; userName: string | null; content: string }>,
): { text: string; lookup: UserLookup } {
  const lookup = buildUserLookup(messages);

  const lines = messages.map((m) => {
    const name = lookup.names.get(m.userId) ?? "Unknown";
    return `${name}: ${m.content}`;
  });

  return {
    text: lines.join("\n---\n"),
    lookup,
  };
}

/** Validate that no raw user IDs appear in AI output. */
export function containsRawUserIds(text: string, knownIds: number[]): boolean {
  for (const id of knownIds) {
    // Match standalone numbers that look like Telegram IDs (8-10 digits)
    if (String(id).length >= 7 && text.includes(String(id))) {
      return true;
    }
  }
  return false;
}

/** Clean up vague attributions in AI output.
 *  Replaces patterns like "участник N" or "User_N" with proper names if possible. */
export function sanitizeAttributions(text: string, lookup: UserLookup): string {
  let result = text;

  // Replace "User_<id>" patterns with display names
  for (const [userId, name] of lookup.names) {
    const pattern = new RegExp(`User_${userId}`, "g");
    result = result.replace(pattern, name);
  }

  return result;
}
