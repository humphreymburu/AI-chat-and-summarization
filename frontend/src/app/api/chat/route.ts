import { backendFetch } from "@unep/lib/backend";
import { getUserId } from "@unep/lib/conversations";
import { consumeChatQuota, getClientIp, quotaMessage } from "@unep/lib/usage";

// Answers can take a while to stream.
export const maxDuration = 120;

const MAX_BODY_BYTES = 500_000;
const MAX_QUESTION_CHARS = 4_000;
// Only the most recent messages are sent to the backend as context.
const MAX_HISTORY_MESSAGES = 20;

type UIPart = { type?: string; text?: string };
type UIMessageLike = { role?: string; parts?: UIPart[] };

// The AI SDK chat shows the response text as the error message, so errors
// are plain text.
const textError = (message: string, status: number) =>
  new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

function messageText(message: UIMessageLike | undefined) {
  return (message?.parts ?? [])
    .map((p) => (p.type === "text" ? p.text ?? "" : ""))
    .join("");
}

// Proxies the chat to the backend after checking the daily question limit.
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return textError("This conversation is too long. Please start a new chat.", 413);
  }

  let body: { messages?: UIMessageLike[]; [key: string]: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return textError("Invalid request.", 400);
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const question = messageText(lastUser).trim();
  if (!question) return textError("Please enter a question.", 400);
  if (question.length > MAX_QUESTION_CHARS) {
    return textError(
      `Please keep questions under ${MAX_QUESTION_CHARS.toLocaleString()} characters.`,
      400
    );
  }

  const userId = await getUserId();
  const quota = await consumeChatQuota(userId, getClientIp(req.headers));
  if (!quota.allowed) {
    return textError(quotaMessage(quota.limit, Boolean(userId)), 429);
  }

  let upstream: Response;
  try {
    upstream = await backendFetch("/chat/ui", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        messages: messages.slice(-MAX_HISTORY_MESSAGES),
        // Decided here from the session; overrides anything the client sent.
        // Guests are answered by the backend's GUEST_MODEL when one is set.
        tier: userId ? "member" : "guest",
      }),
      // Stops the backend work when the user presses Stop.
      signal: req.signal,
    });
  } catch {
    return textError("The answer service is unavailable. Please try again.", 502);
  }
  if (!upstream.ok || !upstream.body) {
    return textError("The answer service is unavailable. Please try again.", 502);
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}
