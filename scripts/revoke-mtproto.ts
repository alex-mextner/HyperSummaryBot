import { rmSync } from "node:fs";
import { TelegramClient } from "@mtcute/bun";
import {
  DEFAULT_MTPROTO_SESSION_PATH,
  prepareMtProtoSessionStorage,
} from "../src/services/mtproto-admin";

function requireConfig(name: "MTPROTO_API_ID" | "MTPROTO_API_HASH"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function revokeSession(): Promise<void> {
  if (
    process.env.CONFIRM_REVOKE_MTPROTO !== "YES" ||
    process.env.MTPROTO_ADMIN_BOT_STOPPED !== "YES"
  ) {
    throw new Error(
      "Set CONFIRM_REVOKE_MTPROTO=YES and MTPROTO_ADMIN_BOT_STOPPED=YES after stopping the bot process",
    );
  }
  const apiId = Number(requireConfig("MTPROTO_API_ID"));
  if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new Error("Invalid MTPROTO_API_ID");
  const apiHash = requireConfig("MTPROTO_API_HASH");
  const sessionPath = process.env.MTPROTO_SESSION_PATH || DEFAULT_MTPROTO_SESSION_PATH;
  prepareMtProtoSessionStorage(sessionPath);

  const client = new TelegramClient({ apiId, apiHash, storage: sessionPath });
  try {
    await client.start();
    await client.logOut();
  } finally {
    await client.destroy();
  }

  for (const path of [sessionPath, `${sessionPath}-wal`, `${sessionPath}-shm`]) {
    rmSync(path, { force: true });
  }
  console.log("MTProto session revoked and local session files removed.");
}

async function main(): Promise<void> {
  const previousUmask = process.umask(0o077);
  try {
    await revokeSession();
  } finally {
    process.umask(previousUmask);
  }
}

if (import.meta.main) {
  main().catch(() => {
    console.error("MTProto revocation failed; verify the stopped bot and configuration locally.");
    process.exitCode = 1;
  });
}
