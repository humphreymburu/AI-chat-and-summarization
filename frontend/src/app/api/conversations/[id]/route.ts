import { z } from "zod";

import {
  getUserId,
  ID_PATTERN,
  MAX_BODY_BYTES,
  MAX_MESSAGES,
  titleFromMessages,
  unauthorized,
} from "@unep/lib/conversations";
import { pool } from "@unep/lib/db";

type Params = { params: Promise<{ id: string }> };

const notFound = () =>
  Response.json({ error: "Conversation not found" }, { status: 404 });

// Messages are AI SDK UIMessages; only the outer shape is checked here.
const SaveBody = z.object({
  messages: z
    .array(
      z.looseObject({
        id: z.string().max(200),
        role: z.enum(["user", "assistant", "system"]),
        parts: z.array(z.looseObject({ type: z.string() })),
      })
    )
    .max(MAX_MESSAGES),
});

export async function GET(_req: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();
  const { id } = await params;
  if (!ID_PATTERN.test(id)) return notFound();

  const { rows } = await pool.query(
    `select id, title, messages, updated_at as "updatedAt"
       from conversation
      where id = $1 and user_id = $2`,
    [id, userId]
  );
  return rows[0] ? Response.json(rows[0]) : notFound();
}

// Creates or replaces a conversation's messages.
export async function PUT(req: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();
  const { id } = await params;
  if (!ID_PATTERN.test(id)) return notFound();

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Conversation too large" }, { status: 413 });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = SaveBody.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "Invalid conversation" }, { status: 400 });
  }

  const messages = parsed.data.messages;
  const title = titleFromMessages(messages as never);
  // The update only applies to the owner's row, so another user's id can't be
  // overwritten; in that case no row comes back and we return 404.
  const { rows } = await pool.query(
    `insert into conversation (id, user_id, title, messages)
          values ($1, $2, $3, $4::jsonb)
     on conflict (id) do update
           set title = excluded.title,
               messages = excluded.messages,
               updated_at = now()
         where conversation.user_id = excluded.user_id
     returning id, title, updated_at as "updatedAt"`,
    [id, userId, title, JSON.stringify(messages)]
  );
  return rows[0] ? Response.json(rows[0]) : notFound();
}

export async function DELETE(_req: Request, { params }: Params) {
  const userId = await getUserId();
  if (!userId) return unauthorized();
  const { id } = await params;
  if (!ID_PATTERN.test(id)) return notFound();

  const { rowCount } = await pool.query(
    "delete from conversation where id = $1 and user_id = $2",
    [id, userId]
  );
  return rowCount ? new Response(null, { status: 204 }) : notFound();
}
