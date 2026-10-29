import { backendFetch } from "@unep/lib/backend";
import { getUserId } from "@unep/lib/conversations";
import { consumeChatQuota, getClientIp, quotaMessage } from "@unep/lib/usage";

export const maxDuration = 120;

const MAX_BODY_BYTES = 20_000;

// Forwards the summary request to the backend /search endpoint. Each summary
// counts as one question against the daily limit.
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Question is too long." }, { status: 413 });
  }

  const userId = await getUserId();
  const quota = await consumeChatQuota(userId, getClientIp(req.headers));
  if (!quota.allowed) {
    return Response.json(
      { error: quotaMessage(quota.limit, Boolean(userId)) },
      { status: 429 }
    );
  }

  try {
    const response = await backendFetch("/search", {
      method: "POST",
      body: raw,
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return Response.json(
      { error: "The summary service is unavailable. Please try again." },
      { status: 502 }
    );
  }
}
