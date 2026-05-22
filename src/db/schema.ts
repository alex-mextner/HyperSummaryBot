import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id", { mode: "number" }).notNull(),
    messageId: integer("message_id", { mode: "number" }).notNull(),
    userId: integer("user_id", { mode: "number" }).notNull(),
    userName: text("user_name"),
    role: text("role", { enum: ["user", "assistant", "system", "tool"] }).notNull(),
    content: text("content").notNull(),
    replyToMessageId: integer("reply_to_message_id", { mode: "number" }),
    forwardFromName: text("forward_from_name"),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("messages_chat_message_unique").on(table.chatId, table.messageId)],
);

export const chatConfigs = sqliteTable("chat_configs", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id", { mode: "number" }).notNull().unique(),
  language: text("language").default("en"),
  timezone: text("timezone").default("UTC"),
  summaryStyle: text("summary_style", { enum: ["concise", "detailed", "bullet"] }).default(
    "detailed",
  ),
  notionDatabaseId: text("notion_database_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const summaries = sqliteTable("summaries", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id", { mode: "number" }).notNull(),
  type: text("type").notNull(),
  content: text("content").notNull(),
  messageIds: text("message_ids"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const chats = sqliteTable("chats", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id", { mode: "number" }).notNull().unique(),
  title: text("title").notNull(),
  type: text("type"),
  username: text("username"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});
