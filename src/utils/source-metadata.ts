/** Bot API/raw TL use seconds; mtcute 0.29.7 high-level Message.date uses Date.
 * Preserve either authoritative representation; never substitute arrival time. */
export function sourceDate(value: unknown): Date | null {
  if (value === undefined || value === null || value === 0) return null;
  const date =
    value instanceof Date
      ? value
      : typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? new Date(value * 1000)
        : null;
  if (!date || !Number.isFinite(date.getTime()) || date.getTime() < 0)
    throw new Error("Invalid source timestamp");
  return date;
}

export function sameChatReplyId(id: number | null | undefined, origin?: string): number | null {
  if (origin && origin !== "same_chat") return null;
  return id !== undefined && id !== null && Number.isSafeInteger(id) && id > 0 ? id : null;
}
