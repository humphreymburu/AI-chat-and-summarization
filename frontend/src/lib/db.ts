import { Pool } from "pg";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

// Node gives each IPv4/IPv6 address only 250 ms to connect by default, which
// fails on slower links to Neon. Allow 3 s per attempt.
setDefaultAutoSelectFamilyAttemptTimeout(3000);

// One pool per server process. In dev, hot reloads would otherwise open a new
// pool on every change, so keep it on globalThis.
const globalForDb = globalThis as unknown as { pgPool?: Pool };

export const pool =
  globalForDb.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
  });

if (process.env.NODE_ENV !== "production") globalForDb.pgPool = pool;
