// Applies db/migrations/*.sql in order, once each. Run after the Better Auth
// tables exist (npm run db:migrate does both).
import pg from "pg";

import { readdir, readFile } from "node:fs/promises";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import path from "node:path";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on the real environment (e.g. CI or Vercel).
}

// Allow slower links to Neon (Node's default is 250 ms per address).
setDefaultAutoSelectFamilyAttemptTimeout(3000);

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`create table if not exists _migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  const dir = path.resolve("db/migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await client.query("select name from _migrations");
  const done = new Set(rows.map((r) => r.name));
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into _migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  }
  console.log("migrations up to date");
} finally {
  await client.end();
}
