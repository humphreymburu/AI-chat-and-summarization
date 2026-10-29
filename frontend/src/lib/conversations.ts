import type { UIMessage } from "ai";
import { headers } from "next/headers";

import { auth } from "./auth";

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export type ConversationDetail = ConversationSummary & {
  messages: UIMessage[];
};

// Limits for a saved conversation.
export const MAX_MESSAGES = 400;
export const MAX_BODY_BYTES = 2_000_000;
export const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Returns the signed-in user's id, or null for guests. */
export async function getUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user.id ?? null;
}

/** Title shown in the sidebar: the first question, shortened. */
export function titleFromMessages(messages: UIMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = firstUser?.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "New conversation";
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

export const unauthorized = () =>
  Response.json({ error: "Sign in to save conversations" }, { status: 401 });
