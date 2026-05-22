import { eq, desc, and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { messages } from "../schema";

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
  createdAt: Date;
}

export class ChatHistoryRepository {
  private db: ReturnType<typeof drizzle>;

  constructor(database: Database) {
    this.db = drizzle(database);
  }

  async save(data: Omit<ChatMessage, "id" | "createdAt">): Promise<number> {
    const result = await this.db
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
      })
      .returning({ id: messages.id });
    return result[0]?.id ?? -1;
  }

  async updateContent(chatId: number, messageId: number, content: string): Promise<void> {
    await this.db
      .update(messages)
      .set({ content })
      .where(and(eq(messages.chatId, chatId), eq(messages.messageId, messageId)));
  }

  async getRecent(chatId: number, limit: number = 50): Promise<ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.createdAt))
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
          sql`${messages.createdAt} >= ${startTime}`,
          sql`${messages.createdAt} <= ${endTime}`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return rows.reverse().map((row) => this.mapRow(row));
  }

  async pruneOld(chatId: number, keepCount: number = 99999): Promise<number> {
    const subquery = this.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.createdAt))
      .limit(keepCount)
      .as("keep");

    await this.db
      .delete(messages)
      .where(
        and(eq(messages.chatId, chatId), sql`${messages.id} NOT IN (SELECT id FROM ${subquery})`),
      );
    return 0; // Drizzle doesn't return changes count, query affects rows
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
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(messages.createdAt)
      .limit(1);

    const latest = await this.db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.createdAt))
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
      createdAt: row.createdAt ?? new Date(),
    };
  }
}
