import { eq, desc, and, sql, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { messages, chats } from "../schema";

export interface ChatMessage {
  id: number;
  chatId: number;
  messageId: number;
  userId: number;
  userName: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  replyToMessageId: number | null;
  forwardFromName: string | null;
  /** Backward-compatible alias for first ingestion, not the message's source time. */
  createdAt: Date;
  ingestedAt: Date | null;
  sourceCreatedAt: Date | null;
  sourceEditedAt: Date | null;
  threadId: number | null;
  sourceKind: "legacy" | "bot_api" | "mtproto" | "dump";
  contentKind: "text" | "placeholder" | "transcription";
  contentVersion: number;
}

export type ChatMessageInput = Omit<
  ChatMessage,
  | "id"
  | "createdAt"
  | "ingestedAt"
  | "contentVersion"
  | "sourceCreatedAt"
  | "sourceEditedAt"
  | "threadId"
  | "sourceKind"
  | "contentKind"
> &
  Partial<
    Pick<
      ChatMessage,
      "sourceCreatedAt" | "sourceEditedAt" | "threadId" | "sourceKind" | "contentKind"
    >
  >;

function normalizeSourceDate(value: Date | null | undefined): Date | null {
  if (value == null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime() < 0)
    throw new Error("Invalid source message timestamp");
  return new Date(Math.floor(value.getTime() / 1000) * 1000);
}
function dateKey(value: Date | null): number | null {
  return value?.getTime() ?? null;
}

export class ChatHistoryRepository {
  private db: ReturnType<typeof drizzle>;

  constructor(database: Database) {
    this.db = drizzle(database);
  }

  async save(data: ChatMessageInput): Promise<number> {
    const result = await this.saveWithOutcome(data);
    return result.outcome === "inserted" ? result.id : -1;
  }

  async saveWithOutcome(
    data: ChatMessageInput,
  ): Promise<{ id: number; outcome: "inserted" | "updated" | "unchanged" }> {
    const sourceCreatedAt = normalizeSourceDate(data.sourceCreatedAt);
    const sourceEditedAt = normalizeSourceDate(data.sourceEditedAt);
    const contentKind =
      data.contentKind ??
      (data.content === "[Media/Empty]" || data.content.startsWith("[Voice message -")
        ? "placeholder"
        : "text");
    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, data.chatId), eq(messages.messageId, data.messageId)))
        .get();
      if (!existing) {
        const inserted = tx
          .insert(messages)
          .values({
            chatId: data.chatId,
            messageId: data.messageId,
            userId: data.userId,
            userName: data.userName,
            role: data.role,
            content: data.content,
            replyToMessageId: data.replyToMessageId,
            forwardFromName: data.forwardFromName,
            sourceCreatedAt,
            sourceEditedAt,
            threadId: data.threadId ?? null,
            sourceKind: data.sourceKind ?? "legacy",
            contentKind,
            contentVersion: 1,
          })
          .returning({ id: messages.id })
          .get();
        if (!inserted) throw new Error("Message insert returned no row");
        return { id: inserted.id, outcome: "inserted" as const };
      }
      const staleEdit =
        existing.sourceEditedAt !== null &&
        (sourceEditedAt?.getTime() ?? 0) < existing.sourceEditedAt.getTime();
      const weakerContent =
        (existing.contentKind === "transcription" && contentKind !== "transcription") ||
        (existing.contentKind !== "placeholder" && contentKind === "placeholder");
      const acceptContent = !staleEdit && !weakerContent;
      const content = acceptContent ? data.content : existing.content;
      const keptKind = acceptContent ? contentKind : existing.contentKind;
      const sourceDate = existing.sourceCreatedAt ?? sourceCreatedAt;
      const editedDate = !staleEdit && sourceEditedAt ? sourceEditedAt : existing.sourceEditedAt;
      const threadId = existing.threadId ?? data.threadId ?? null;
      const replyToMessageId = staleEdit
        ? existing.replyToMessageId
        : (data.replyToMessageId ?? existing.replyToMessageId);
      const forwardFromName = staleEdit
        ? existing.forwardFromName
        : (data.forwardFromName ?? existing.forwardFromName);
      const userName =
        data.userName && data.userName !== String(data.userId) ? data.userName : existing.userName;
      const sourceKind =
        data.sourceKind && data.sourceKind !== "legacy" ? data.sourceKind : existing.sourceKind;
      const changed =
        sourceKind !== existing.sourceKind ||
        content !== existing.content ||
        keptKind !== existing.contentKind ||
        userName !== existing.userName ||
        threadId !== existing.threadId ||
        replyToMessageId !== existing.replyToMessageId ||
        forwardFromName !== existing.forwardFromName ||
        dateKey(sourceDate) !== dateKey(existing.sourceCreatedAt) ||
        dateKey(editedDate) !== dateKey(existing.sourceEditedAt);
      tx.update(messages)
        .set({
          content,
          contentKind: keptKind,
          userName,
          threadId,
          replyToMessageId,
          forwardFromName,
          sourceCreatedAt: sourceDate,
          sourceEditedAt: editedDate,
          sourceKind,
          contentVersion: existing.contentVersion + (changed ? 1 : 0),
        })
        .where(eq(messages.id, existing.id))
        .run();
      return { id: existing.id, outcome: changed ? ("updated" as const) : ("unchanged" as const) };
    });
  }

  async updateContent(
    chatId: number,
    messageId: number,
    content: string,
    contentKind: ChatMessage["contentKind"] = "text",
  ): Promise<void> {
    await this.db
      .update(messages)
      .set({ content, contentKind, contentVersion: sql`${messages.contentVersion} + 1` })
      .where(
        and(
          eq(messages.chatId, chatId),
          eq(messages.messageId, messageId),
          sql`(${messages.content} != ${content} OR ${messages.contentKind} != ${contentKind})`,
          // A late failure placeholder must never replace successful speech/text.
          ...(contentKind === "placeholder" ? [eq(messages.contentKind, "placeholder")] : []),
        ),
      );
  }

  async deleteByMessageIds(chatId: number, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return;
    await this.db
      .delete(messages)
      .where(and(eq(messages.chatId, chatId), inArray(messages.messageId, messageIds)));
  }

  async getRecent(chatId: number, limit: number = 50): Promise<ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.messageId))
      .limit(limit);
    return rows.reverse().map((row) => this.mapRow(row));
  }

  async getByTimeRange(
    chatId: number,
    startTime: Date,
    endTime: Date,
    limit: number = 99999,
  ): Promise<ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          sql`${messages.sourceCreatedAt} >= ${Math.floor(startTime.getTime() / 1000)}`,
          sql`${messages.sourceCreatedAt} <= ${Math.floor(endTime.getTime() / 1000)}`,
        ),
      )
      .orderBy(desc(messages.messageId))
      .limit(limit);
    return rows.reverse().map((row) => this.mapRow(row));
  }

  async pruneOld(chatId: number, keepCount: number = 99999): Promise<number> {
    const subquery = this.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.messageId))
      .limit(keepCount)
      .as("keep");

    await this.db
      .delete(messages)
      .where(
        and(eq(messages.chatId, chatId), sql`${messages.id} NOT IN (SELECT id FROM ${subquery})`),
      );
    return 0; // Drizzle doesn't return changes count, query affects rows
  }

  async checkExists(chatId: number, messageId: number): Promise<boolean> {
    const result = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.messageId, messageId)))
      .limit(1);
    return result.length > 0;
  }

  async checkExistsBatch(chatId: number, messageIds: number[]): Promise<Set<number>> {
    if (messageIds.length === 0) return new Set();
    const result = await this.db
      .select({ messageId: messages.messageId })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), inArray(messages.messageId, messageIds)));
    return new Set(result.map((r) => r.messageId));
  }

  async saveChat(data: {
    chatId: number;
    title: string;
    type?: string;
    username?: string;
  }): Promise<void> {
    await this.db
      .insert(chats)
      .values({
        chatId: data.chatId,
        title: data.title,
        type: data.type ?? null,
        username: data.username ?? null,
      })
      .onConflictDoUpdate({
        target: [chats.chatId],
        set: {
          title: data.title,
          type: data.type ?? null,
          username: data.username ?? null,
          updatedAt: new Date(),
        },
      });
  }

  async getChat(chatId: number): Promise<{ title: string | null; type: string | null } | null> {
    const result = await this.db.select().from(chats).where(eq(chats.chatId, chatId)).limit(1);
    return result[0] ? { title: result[0].title, type: result[0].type } : null;
  }

  async getAllChatIds(): Promise<number[]> {
    const result = await this.db
      .select({ chatId: messages.chatId })
      .from(messages)
      .groupBy(messages.chatId);
    return result.map((r) => r.chatId);
  }

  async getChatStats(
    chatId: number,
  ): Promise<{ total: number; earliestDate: Date | null; latestDate: Date | null }> {
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(eq(messages.chatId, chatId));

    const total = countResult[0]?.count ?? 0;

    if (total === 0) {
      return { total: 0, earliestDate: null, latestDate: null };
    }

    const earliest = await this.db
      .select({ createdAt: messages.sourceCreatedAt })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), sql`${messages.sourceCreatedAt} IS NOT NULL`))
      .orderBy(messages.sourceCreatedAt)
      .limit(1);

    const latest = await this.db
      .select({ createdAt: messages.sourceCreatedAt })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), sql`${messages.sourceCreatedAt} IS NOT NULL`))
      .orderBy(desc(messages.sourceCreatedAt))
      .limit(1);

    return {
      total,
      earliestDate: earliest[0]?.createdAt ?? null,
      latestDate: latest[0]?.createdAt ?? null,
    };
  }

  private mapRow(row: typeof messages.$inferSelect): ChatMessage {
    return {
      id: row.id,
      chatId: row.chatId,
      messageId: row.messageId,
      userId: row.userId,
      userName: row.userName,
      role: row.role as ChatMessage["role"],
      content: row.content,
      replyToMessageId: row.replyToMessageId,
      forwardFromName: row.forwardFromName,
      createdAt: row.createdAt ?? new Date(0),
      ingestedAt: row.createdAt,
      sourceCreatedAt: row.sourceCreatedAt,
      sourceEditedAt: row.sourceEditedAt,
      threadId: row.threadId,
      sourceKind: row.sourceKind,
      contentKind: row.contentKind,
      contentVersion: row.contentVersion,
    };
  }
}
