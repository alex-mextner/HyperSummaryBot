import { eq, and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Database } from "bun:sqlite";
import { debts } from "../db/schema";

/** Normalized currency codes for common currencies.
 *  Maps informal symbols/abbreviations to ISO-4217 or common codes. */
const CURRENCY_NORMALIZATION: Record<string, string> = {
  // Serbian Dinar
  дин: "RSD",
  динар: "RSD",
  din: "RSD",
  dinar: "RSD",
  rsd: "RSD",
  // Euro
  евро: "EUR",
  euro: "EUR",
  "\u20AC": "EUR",
  eur: "EUR",
  // US Dollar
  доллар: "USD",
  доллара: "USD",
  долларов: "USD",
  dollar: "USD",
  $: "USD",
  usd: "USD",
  // Russian Ruble
  руб: "RUB",
  рубль: "RUB",
  рубля: "RUB",
  рублей: "RUB",
  rub: "RUB",
  "\u20BD": "RUB",
  // Swiss Franc
  франк: "CHF",
  chf: "CHF",
  // British Pound
  фунт: "GBP",
  "\u00A3": "GBP",
  gbp: "GBP",
  // Other common
  yuan: "CNY",
  юань: "CNY",
  cny: "CNY",
  yen: "JPY",
  йен: "JPY",
  jpy: "JPY",
  krona: "SEK",
  крона: "SEK",
  sek: "SEK",
  pln: "PLN",
  zloty: "PLN",
  злотый: "PLN",
};

/** Currency decimal places (for conversion to/from smallest unit). */
const CURRENCY_DECIMALS: Record<string, number> = {
  RSD: 2,
  EUR: 2,
  USD: 2,
  RUB: 2,
  CHF: 2,
  GBP: 2,
  CNY: 2,
  JPY: 0,
  SEK: 2,
  PLN: 2,
};

export interface DebtRecord {
  id: number;
  chatId: number;
  creditorUserId: number;
  creditorUserName: string | null;
  debtorUserId: number;
  debtorUserName: string | null;
  amount: number; // stored in smallest unit (cents)
  currency: string;
  description: string | null;
  sourceMessageIds: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

/** Parse amount string to integer in smallest currency unit.
 *  Examples: "35 евро" → 3500 (EUR), "1500 din" → 150000 (RSD), "2000" → 200000 (default RSD)
 *  Returns null if parsing fails. */
export function parseAmount(
  amountStr: string,
  currencyHint?: string,
): { amount: number; currency: string } | null {
  const normalized = amountStr.toLowerCase().trim();

  // Extract numeric part
  const numericMatch = normalized.match(/([\d\s.,]+)/);
  if (!numericMatch) return null;

  let numericPart = numericMatch[1]!.replace(/\s/g, "").replace(/,/g, ".");
  // Handle dot-as-thousands-separator (e.g. "1.000" vs "1.000,50")
  const parts = numericPart.split(".");
  if (parts.length > 2) {
    // Multiple dots — first are thousands, last is decimal
    numericPart = parts.slice(0, -1).join("") + "." + parts[parts.length - 1];
  }

  const rawValue = Number.parseFloat(numericPart);
  if (Number.isNaN(rawValue)) return null;

  // Detect currency from text
  let currency = currencyHint?.toUpperCase() || "RSD";
  for (const [key, code] of Object.entries(CURRENCY_NORMALIZATION)) {
    if (normalized.includes(key.toLowerCase())) {
      currency = code;
      break;
    }
  }

  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  const amount = Math.round(rawValue * 10 ** decimals);

  return { amount, currency };
}

/** Format amount from smallest unit to human-readable. */
export function formatAmount(amount: number, currency: string): string {
  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  const divisor = 10 ** decimals;
  const whole = Math.floor(amount / divisor);
  const frac = amount % divisor;
  const formatted =
    decimals > 0 ? `${whole}.${String(frac).padStart(decimals, "0")}` : String(whole);
  return `${formatted} ${currency}`;
}

export class DebtTracker {
  private db: ReturnType<typeof drizzle>;

  constructor(database: Database) {
    this.db = drizzle(database);
  }

  /** Save or update a debt. Uses (chatId, creditor, debtor, description) as unique key. */
  async saveDebt(record: Omit<DebtRecord, "id" | "createdAt" | "settledAt">): Promise<void> {
    await this.db
      .insert(debts)
      .values({
        chatId: record.chatId,
        creditorUserId: record.creditorUserId,
        creditorUserName: record.creditorUserName,
        debtorUserId: record.debtorUserId,
        debtorUserName: record.debtorUserName,
        amount: record.amount,
        currency: record.currency,
        description: record.description,
        sourceMessageIds: record.sourceMessageIds,
      })
      .onConflictDoUpdate({
        target: [debts.chatId, debts.creditorUserId, debts.debtorUserId, debts.description],
        set: {
          amount: record.amount,
          currency: record.currency,
          creditorUserName: record.creditorUserName,
          debtorUserName: record.debtorUserName,
          sourceMessageIds: record.sourceMessageIds,
        },
      });
  }

  /** Mark a debt as settled. */
  async settleDebt(
    chatId: number,
    creditorUserId: number,
    debtorUserId: number,
    description: string | null,
  ): Promise<void> {
    await this.db
      .update(debts)
      .set({ settledAt: new Date() })
      .where(
        and(
          eq(debts.chatId, chatId),
          eq(debts.creditorUserId, creditorUserId),
          eq(debts.debtorUserId, debtorUserId),
          description ? eq(debts.description, description) : sql`1=1`,
        ),
      );
  }

  /** Get all active (unsettled) debts for a chat, aggregated by creditor→debtor. */
  async getActiveDebts(chatId: number): Promise<DebtRecord[]> {
    return this.db
      .select()
      .from(debts)
      .where(and(eq(debts.chatId, chatId), sql`${debts.settledAt} IS NULL`))
      .all() as unknown as DebtRecord[];
  }

  /** Get net balance for each user in a chat (who owes / is owed). */
  async getBalances(
    chatId: number,
  ): Promise<
    Array<{ userId: number; userName: string | null; balance: number; currency: string }>
  > {
    const rows = await this.db
      .select({
        userId: sql<number>`CASE WHEN ${debts.creditorUserId} = ${debts.debtorUserId} THEN ${debts.creditorUserId} ELSE ${debts.creditorUserId} END`,
        userName: debts.creditorUserName,
        balance: sql<number>`SUM(${debts.amount})`,
        currency: debts.currency,
      })
      .from(debts)
      .where(and(eq(debts.chatId, chatId), sql`${debts.settledAt} IS NULL`))
      .groupBy(debts.creditorUserId, debts.currency)
      .all();

    // Also subtract what each user owes
    const owes = await this.db
      .select({
        userId: debts.debtorUserId,
        userName: debts.debtorUserName,
        balance: sql<number>`-SUM(${debts.amount})`,
        currency: debts.currency,
      })
      .from(debts)
      .where(and(eq(debts.chatId, chatId), sql`${debts.settledAt} IS NULL`))
      .groupBy(debts.debtorUserId, debts.currency)
      .all();

    const merged = new Map<
      string,
      { userId: number; userName: string | null; balance: number; currency: string }
    >();
    for (const row of [...rows, ...owes]) {
      const key = `${row.userId}-${row.currency}`;
      const existing = merged.get(key);
      if (existing) {
        existing.balance += row.balance;
      } else {
        merged.set(key, {
          userId: row.userId,
          userName: row.userName,
          balance: row.balance,
          currency: row.currency,
        });
      }
    }

    return Array.from(merged.values());
  }
}
