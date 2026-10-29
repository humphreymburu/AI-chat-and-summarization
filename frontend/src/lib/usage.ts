import { pool } from "./db";

const GUEST_LIMIT = Number(process.env.CHAT_DAILY_LIMIT_GUEST ?? 10);
const USER_LIMIT = Number(process.env.CHAT_DAILY_LIMIT_USER ?? 100);

export type QuotaResult = { allowed: boolean; limit: number };

/**
 * The visitor's IP address. Vercel and Coolify's proxy set x-forwarded-for,
 * with the real client address first.
 */
export function getClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip") || "unknown";
}

/**
 * Counts one question against today's limit. Signed-in users are counted by
 * account, guests by IP address. Returns allowed=false once the limit is hit.
 */
export async function consumeChatQuota(
  userId: string | null,
  ip: string
): Promise<QuotaResult> {
  const subject = userId ? `user:${userId}` : `ip:${ip}`;
  const limit = userId ? USER_LIMIT : GUEST_LIMIT;
  if (limit <= 0) return { allowed: false, limit };

  // Atomic: the update only happens while under the limit, so parallel
  // requests can't push the count past it.
  const { rowCount } = await pool.query(
    `insert into chat_usage (subject, day, count)
          values ($1, current_date, 1)
     on conflict (subject, day) do update
           set count = chat_usage.count + 1
         where chat_usage.count < $2
     returning count`,
    [subject, limit]
  );
  return { allowed: (rowCount ?? 0) > 0, limit };
}

export function quotaMessage(limit: number, signedIn: boolean): string {
  return signedIn
    ? `You've reached today's limit of ${limit} questions. Please come back tomorrow.`
    : `You've reached today's limit of ${limit} questions as a guest. Log in or sign up to ask more.`;
}
