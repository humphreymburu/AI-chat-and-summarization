import type { UIMessage } from "ai";

import type { SummaryResponse } from "@unep/bundles/search/results/summary-types";

const KEY = "ecobuddy-chat-seed";

/** Remembers a summary so /chat can open a follow-up conversation from it. */
export function saveChatSeed(data: SummaryResponse): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Storage can be blocked; the chat then simply opens empty.
  }
}

/** Removes the saved summary once the chat has used it. */
export function clearChatSeed(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear if storage is blocked.
  }
}

/** Reads a saved summary as the first two messages (does not remove it). */
export function peekChatSeed(): UIMessage[] | undefined {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return undefined;
    const data = JSON.parse(raw) as SummaryResponse;
    const answer = data.summary?.executive_summary;
    if (!data.query || !answer) return undefined;

    const seen = new Set<string>();
    const sources = (data.documents ?? []).flatMap((doc, i) => {
      if (!doc.url || seen.has(doc.url)) return [];
      seen.add(doc.url);
      return [
        {
          type: "source-url" as const,
          sourceId: `seed-src-${i}`,
          url: doc.url,
          title: doc.title,
          providerMetadata: { unep: { source: doc.source ?? "" } },
        },
      ];
    });

    return [
      {
        id: "seed-user",
        role: "user",
        parts: [{ type: "text", text: data.query }],
      },
      {
        id: "seed-assistant",
        role: "assistant",
        parts: [...sources, { type: "text", text: answer }],
      },
    ];
  } catch {
    return undefined;
  }
}
