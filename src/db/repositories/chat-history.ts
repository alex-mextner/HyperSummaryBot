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
  createdAt: Date;
}

export class ChatHistoryRepository {
  private db: ReturnType<typeof drizzle>;

  constructor(database: Database) {
    this.db = drizzle(database);
  }

  async save(data: Omit<ChatMessage, "id" | "createdAt">): Promise<number> {
    try {
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
    } catch (err: any) {
      // Handle duplicate by updating (edit or re-import)
      if (err.message?.includes("UNIQUE constraint failed")) {
        await this.db
          .update(messages)
          .set({
            content: data.content,
            userName: data.userName,
            replyToMessageId: data.replyToMessageId,
            forwardFromName: data.forwardFromName,
          })
          .where(and(eq(messages.chatId, data.chatId), eq(messages.messageId, data.messageId)));
        return -1;
      }
      throw err;
    }
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
          sql`${messages.createdAt} >= ${Math.floor(startTime.getTime() / 1000)}`,
          sql`${messages.createdAt} <= ${Math.floor(endTime.getTime() / 1000)}`,
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
