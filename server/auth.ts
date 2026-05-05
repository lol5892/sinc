import crypto from "node:crypto";

/** Проверка подписи Telegram Web App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) */
export function parseAndValidateInitData(
  initData: string,
  botToken: string,
  maxAgeSec = 86400,
): {
  userId: number;
  user: { id: number; first_name?: string; last_name?: string; username?: string };
  raw: Record<string, string>;
} | null {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  const authDate = params.get("auth_date");
  if (!authDate) return null;
  const age = Math.floor(Date.now() / 1000) - Number(authDate);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeSec) return null;

  const pairs: string[] = [];
  for (const [k, v] of params.entries()) {
    if (k === "hash") continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculated = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculated !== hash) return null;

  const userJson = params.get("user");
  if (!userJson) return null;
  try {
    const user = JSON.parse(userJson) as { id?: number; first_name?: string; last_name?: string; username?: string };
    if (typeof user.id !== "number") return null;
    const raw: Record<string, string> = {};
    for (const [k, v] of params.entries()) raw[k] = v;
    return { userId: user.id, user: { ...user, id: user.id }, raw };
  } catch {
    return null;
  }
}
