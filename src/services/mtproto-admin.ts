import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_MTPROTO_SESSION_PATH = "data/mtcute-session";

export function normalizeAdminPhone(raw: string): string {
  const phone = raw.replace(/[\s\-()]/g, "");
  const normalized = phone.startsWith("+") ? phone : `+${phone}`;
  if (!/^\+\d{7,15}$/.test(normalized)) {
    throw new Error("Phone must contain 7–15 digits in international format");
  }
  return normalized;
}

export function normalizeAdminOtp(raw: string): string {
  const code = raw.replace(/[\s-]/g, "");
  if (!/^\d{5}$/.test(code)) throw new Error("Telegram code must contain exactly 5 digits");
  return code;
}

export function prepareMtProtoSessionStorage(sessionPath: string): void {
  const directory = dirname(sessionPath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  for (const path of [sessionPath, `${sessionPath}-wal`, `${sessionPath}-shm`]) {
    try {
      chmodSync(path, 0o600);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
}
