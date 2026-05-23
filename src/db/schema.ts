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

/** Debt / liability tracking — amounts stored in smallest currency unit (integer cents).
 *  SQLite integer is 64-bit signed, max ~9.2e18, sufficient for all realistic amounts. */
export const debts = sqliteTable(
  "debts",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id", { mode: "number" }).notNull(),
    /** Who is owed money (creditor) */
    creditorUserId: integer("creditor_user_id", { mode: "number" }).notNull(),
    creditorUserName: text("creditor_user_name"),
    /** Who owes money (debtor) */
    debtorUserId: integer("debtor_user_id", { mode: "number" }).notNull(),
    debtorUserName: text("debtor_user_name"),
    /** Amount in smallest currency unit (e.g. cents, kopeks, dinars) — stored as integer */
    amount: integer("amount", { mode: "number" }).notNull(),
    /** ISO-4217 currency code or common symbol (EUR, USD, RSD, RUB, etc.) */
    currency: text("currency").notNull().default("RSD"),
    /** What the debt is for */
    description: text("description"),
    /** JSON array of message IDs that mention this debt */
    sourceMessageIds: text("source_message_ids"),
    /** When the debt was created from chat messages */
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
    /** When the debt was marked as settled */
    settledAt: integer("settled_at", { mode: "timestamp" }),
  },
  (table) => [
    uniqueIndex("debts_chat_creditor_debtor_desc_unique").on(
      table.chatId,
      table.creditorUserId,
      table.debtorUserId,
      table.description,
    ),
  ],
);
