import { getUserId, unauthorized } from "@unep/lib/conversations";
import { pool } from "@unep/lib/db";

// Lists the signed-in user's conversations, newest first.
export async function GET() {
  const userId = await getUserId();
  if (!userId) return unauthorized();

  const { rows } = await pool.query(
    `select id, title, updated_at as "updatedAt"
       from conversation
      where user_id = $1
      order by updated_at desc
      limit 100`,
    [userId]
  );
  return Response.json({ conversations: rows });
}
