import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TelegramClient } from "@mtcute/bun";
import {
  DEFAULT_MTPROTO_SESSION_PATH,
  normalizeAdminOtp,
  normalizeAdminPhone,
  prepareMtProtoSessionStorage,
} from "../src/services/mtproto-admin";

function requireApiId(): number {
  const value = Number(process.env.MTPROTO_API_ID);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("MTPROTO_API_ID is required");
  return value;
}

function requireApiHash(): string {
  const value = process.env.MTPROTO_API_HASH?.trim();
  if (!value) throw new Error("MTPROTO_API_HASH is required");
  return value;
}

async function hiddenQuestion(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string> {
  if (!stdin.isTTY) throw new Error("Secret input requires an interactive TTY");
  execFileSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
  let restored = false;
  const restoreEcho = (): void => {
    if (restored) return;
    restored = true;
    try {
      execFileSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
    } catch {
      console.warn("Unable to restore terminal echo automatically; run `stty echo`.");
    }
  };
  const onSigint = (): void => {
    restoreEcho();
    process.exit(130);
  };
  const onSigterm = (): void => {
    restoreEcho();
    process.exit(143);
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    return await rl.question(prompt);
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    restoreEcho();
    stdout.write("\n");
  }
}

async function main(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error("MTProto login requires a trusted interactive terminal");
  if (process.env.MTPROTO_ADMIN_BOT_STOPPED !== "YES")
    throw new Error("Stop the bot and set MTPROTO_ADMIN_BOT_STOPPED=YES before account login");
  const previousUmask = process.umask(0o077);
  const sessionPath = process.env.MTPROTO_SESSION_PATH || DEFAULT_MTPROTO_SESSION_PATH;
  let rl: ReturnType<typeof createInterface> | undefined;
  let client: TelegramClient | undefined;

  try {
    prepareMtProtoSessionStorage(sessionPath);
    rl = createInterface({ input: stdin, output: stdout, terminal: false });
    const phone = normalizeAdminPhone(await rl.question("Telegram phone (+country…): "));
    client = new TelegramClient({
      apiId: requireApiId(),
      apiHash: requireApiHash(),
      storage: sessionPath,
    });

    await client.start({
      phone,
      code: async () => normalizeAdminOtp(await hiddenQuestion(rl, "Telegram code: ")),
      password: async () => hiddenQuestion(rl, "2FA password: "),
      codeSentCallback: () => console.log("Telegram authorization code sent."),
      invalidCodeCallback: (type) => console.warn(`Invalid ${type}; Telegram will ask again.`),
    });
    prepareMtProtoSessionStorage(sessionPath);
    console.log(`MTProto session authenticated at ${sessionPath}.`);
  } finally {
    try {
      await client?.destroy();
    } finally {
      rl?.close();
      process.umask(previousUmask);
    }
  }
}

if (import.meta.main) {
  main().catch(() => {
    console.error(
      "MTProto admin login failed; verify the stopped bot, TTY and API configuration locally.",
    );
    process.exitCode = 1;
  });
}
