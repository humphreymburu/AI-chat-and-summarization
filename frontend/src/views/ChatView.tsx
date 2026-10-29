"use client";

import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { useStickToBottom } from "use-stick-to-bottom";

import AppShell from "@unep/components/AppShell";
import { useSession } from "@unep/lib/auth-client";
import { clearChatSeed, peekChatSeed } from "@unep/lib/chat-seed";
import type { ConversationSummary } from "@unep/lib/conversations";

// Starting points on the empty state. Clicking a card sends its question
// as written.
const START_CARDS: { id: string; title: string; question: string }[] = [
  {
    id: "climate",
    title: "Climate trends",
    question: "What are the projected carbon emission trends for G20 nations?",
  },
  {
    id: "biodiversity",
    title: "Biodiversity loss",
    question: "What are the main drivers of biodiversity loss?",
  },
  {
    id: "pollution",
    title: "Plastic pollution",
    question: "Summarise the key findings on plastic pollution in oceans.",
  },
  {
    id: "policy",
    title: "Treaties and policy",
    question: "What is the Montreal Protocol and has it worked?",
  },
];

// Follow-up prompts offered under the latest answer.
const FOLLOW_UPS = [
  "Summarise this in three bullet points.",
  "Which sources support this?",
  "What practical steps does this suggest?",
];

type Source = { title: string; url: string; source: string };

// Goes through this app's API, which applies the daily question limit
// before forwarding to the backend.
const CHAT_URL = "/api/chat";

function getMessageText(message: UIMessage) {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

// The backend sends sources as `source-url` parts; the site name rides along
// in providerMetadata.unep.source.
function getMessageSources(message: UIMessage): Source[] {
  return message.parts.flatMap((part) =>
    part.type === "source-url"
      ? [
          {
            title: part.title ?? "Source",
            url: part.url,
            source: String(part.providerMetadata?.unep?.source ?? ""),
          },
        ]
      : []
  );
}

function createConversationId() {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Simple inline markdown: **bold** and bullet lines
function renderMarkdown(text: string) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let bulletBuffer: string[] = [];

  const flushBullets = (key: string) => {
    if (bulletBuffer.length === 0) return;
    elements.push(
      <ul key={key} className="kb-chat-prose-list">
        {bulletBuffer.map((b, i) => (
          <li key={i}>{inlineBold(b)}</li>
        ))}
      </ul>
    );
    bulletBuffer = [];
  };

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushBullets(`flush-${i}`);
      return;
    }
    const bulletMatch = trimmed.match(/^[-•*]\s+(.*)/);
    if (bulletMatch) {
      bulletBuffer.push(bulletMatch[1]);
    } else {
      flushBullets(`flush-${i}`);
      elements.push(
        <p key={i} className="kb-chat-prose-p">
          {inlineBold(trimmed)}
        </p>
      );
    }
  });
  flushBullets("final");
  return elements;
}

function inlineBold(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

function getSourceLabel(source: Source) {
  if (source.source) return source.source;
  if (!source.url) return "Source";
  try {
    return new URL(source.url).hostname.replace(/^www\./, "");
  } catch {
    return "Source";
  }
}

function shouldHideSourcesForAnswer(text: string) {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return [
    "provided context does not",
    "provided context doesn't",
    "provided documents do not",
    "provided documents don't",
    "does not explicitly address",
    "do not explicitly address",
    "does not directly discuss",
    "do not directly discuss",
    "neither directly discusses",
    "neither directly discuss",
    "not include specific information",
    "no relevant documents",
    "need access to",
    "would need access to",
    "would need additional context",
  ].some((phrase) => normalized.includes(phrase));
}

type SessionUser = { id: string; name: string; email: string };

function formatUpdated(value: string) {
  const date = new Date(value);
  const today = new Date();
  const days = Math.floor(
    (new Date(today.toDateString()).getTime() -
      new Date(date.toDateString()).getTime()) /
      86_400_000
  );
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export default function ChatPage() {
  const { data: session, isPending } = useSession();
  const user = session?.user ?? null;

  // Remount on login/logout so chats from one user never leak to another.
  if (isPending) return <AppShell scroll={false}>{null}</AppShell>;
  return <ChatWorkspace key={user?.id ?? "guest"} user={user} />;
}

function ChatWorkspace({ user }: { user: SessionUser | null }) {
  const [firstCid] = useState(createConversationId);
  const [activeCid, setActiveCid] = useState(firstCid);
  // A summary sent here from the Summary page opens as the first messages.
  const [seedMessages] = useState(peekChatSeed);
  useEffect(() => {
    clearChatSeed();
  }, []);
  const [saved, setSaved] = useState<ConversationSummary[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [input, setInput] = useState("");

  // Signed-in users: load their saved conversations once.
  useEffect(() => {
    if (!user) return;
    fetch("/api/conversations")
      .then((res) => (res.ok ? res.json() : { conversations: [] }))
      .then((data) => setSaved(data.conversations ?? []))
      .catch(() => setSaved([]));
  }, [user]);

  const saveConversation = (id: string, messages: UIMessage[]) => {
    if (!user || messages.length === 0) return;
    fetch(`/api/conversations/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((summary: ConversationSummary | null) => {
        if (!summary) return;
        setSaved((prev) => [summary, ...prev.filter((c) => c.id !== id)]);
      })
      .catch(() => {});
  };

  // One Chat per conversation, so switching back keeps its messages and an
  // answer can finish streaming in the background. The chat id is sent as
  // `id` and the backend uses it as the thread id.
  const [transport] = useState(
    () => new DefaultChatTransport<UIMessage>({ api: CHAT_URL })
  );
  const [chats] = useState(() => new Map<string, Chat<UIMessage>>());
  const getChat = (id: string, messages?: UIMessage[]) => {
    let chat = chats.get(id);
    if (!chat) {
      chat = new Chat({
        id,
        transport,
        messages,
        onFinish: ({ messages: all, isError }) => {
          if (!isError) saveConversation(id, all);
        },
      });
      chats.set(id, chat);
    }
    return chat;
  };

  const { messages, sendMessage, status, stop, error, regenerate } = useChat({
    chat: getChat(activeCid, activeCid === firstCid ? seedMessages : undefined),
  });
  const isLoading = status === "submitted" || status === "streaming";

  // Follows the stream while you are at the bottom; scrolling up releases it.
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } =
    useStickToBottom();

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;
    setInput("");
    sendMessage({ text: trimmed }, { body: { scope: "all" } });
  };

  const handleNewChat = () => {
    setActiveCid(createConversationId());
    setInput("");
  };

  const handleOpen = async (id: string) => {
    if (id === activeCid || openingId) return;
    setInput("");
    if (chats.has(id)) {
      setActiveCid(id);
      return;
    }
    setOpeningId(id);
    try {
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) throw new Error("Could not open conversation");
      const data: { messages: UIMessage[] } = await res.json();
      getChat(id, data.messages);
      setActiveCid(id);
    } catch {
      setSaved((prev) => prev.filter((c) => c.id !== id));
    } finally {
      setOpeningId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this conversation?")) return;
    const res = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) return;
    setSaved((prev) => prev.filter((c) => c.id !== id));
    chats.delete(id);
    if (id === activeCid) handleNewChat();
  };

  const firstName = user?.name?.trim().split(/\s+/)[0];
  const isEmpty = messages.length === 0;

  const composer = (
    <Composer
      value={input}
      onChange={setInput}
      onSend={() => send(input)}
      onStop={stop}
      isLoading={isLoading}
      autoFocus={isEmpty}
    />
  );

  const history = user ? (
    <>
      <p className="kb-side-label">Recent</p>
      {saved.length === 0 && (
        <p className="kb-cs-empty">Your conversations will appear here.</p>
      )}
      {saved.map((c) => (
        <div
          key={c.id}
          className={`kb-cs-item${c.id === activeCid ? " active" : ""}${
            c.id === openingId ? " loading" : ""
          }`}
        >
          <button
            type="button"
            className="kb-cs-item-open"
            onClick={() => handleOpen(c.id)}
          >
            <span className="kb-cs-item-title">{truncate(c.title, 40)}</span>
            <span className="kb-cs-item-meta">
              {formatUpdated(c.updatedAt)}
            </span>
          </button>
          <button
            type="button"
            className="kb-cs-item-delete"
            aria-label={`Delete "${c.title}"`}
            title="Delete"
            onClick={() => handleDelete(c.id)}
          >
            ×
          </button>
        </div>
      ))}
    </>
  ) : null;

  return (
    <AppShell history={history} onNewChat={handleNewChat} scroll={false}>
      <div className="kb-chat-page">
        <div className="kb-chat-layout kb-chat-layout-solo">
          {/* ── Main chat area ── */}
          <div className="kb-chat-main">
            {isEmpty ? (
              <div className="kb-chat-hero">
                <h1 className="kb-chat-hero-title">
                  {firstName ? (
                    <span className="kb-hero-hi">
                      Hi <span>{firstName}</span>
                    </span>
                  ) : null}
                  What do you want to explore?
                </h1>
                <p className="kb-chat-hero-lede">
                  Answers come from a library of 10,000+ environmental
                  publications, stories and speeches, with sources cited.
                </p>
                <div className="kb-start-pills">
                  {START_CARDS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="kb-start-pill"
                      title={c.question}
                      onClick={() => send(c.question)}
                    >
                      {c.title}
                    </button>
                  ))}
                </div>

                <div className="kb-chat-hero-composer">{composer}</div>
                {!user && (
                  <p className="kb-chat-hero-note">
                    You&apos;re chatting as a guest, so this chat won&apos;t be
                    saved. <Link href="/login">Log in</Link> or{" "}
                    <Link href="/signup">sign up</Link> to keep your history.
                  </p>
                )}
              </div>
            ) : (
              <>
                <div className="kb-chat-top-bar">
                  <span className="kb-live-dot" />
                  <span className="kb-chat-top-title">
                    {truncate(getMessageText(messages[0]), 60)}
                  </span>
                  {!user && (
                    <Link href="/login" className="kb-chat-top-ctx">
                      Log in to save this chat
                    </Link>
                  )}
                  <button
                    className={`kb-chat-top-clear${user ? " push" : ""}`}
                    onClick={handleNewChat}
                  >
                    New chat
                  </button>
                </div>

                <div className="kb-scroll-fill kb-stick">
                  <div ref={scrollRef} className="kb-chat-scroll">
                    <div
                      ref={contentRef}
                      className="kb-chat-msgs"
                      role="log"
                      aria-live="polite"
                      aria-label="Conversation"
                    >
                      {messages.map((msg, i) => (
                        <ChatMessage
                          key={msg.id ?? i}
                          message={msg}
                          isStreaming={
                            isLoading &&
                            msg.role === "assistant" &&
                            i === messages.length - 1
                          }
                        />
                      ))}

                      {!isLoading &&
                        !error &&
                        messages[messages.length - 1]?.role === "assistant" && (
                          <div
                            className="kb-followups"
                            aria-label="Follow-up questions"
                          >
                            {FOLLOW_UPS.map((q) => (
                              <button
                                key={q}
                                type="button"
                                onClick={() => send(q)}
                              >
                                {q}
                              </button>
                            ))}
                          </div>
                        )}

                      {isLoading &&
                        messages[messages.length - 1].role === "user" && (
                          <TypingDots />
                        )}

                      {error && !isLoading && (
                        <div className="kb-chat-error" role="alert">
                          <span>
                            {error.message ||
                              "Something went wrong. Please try again."}
                          </span>
                          <button
                            className="kb-chat-error-retry"
                            onClick={() => regenerate()}
                          >
                            Retry
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="kb-scroll-down"
                    data-hidden={isAtBottom}
                    tabIndex={isAtBottom ? -1 : 0}
                    aria-label="Scroll to latest message"
                    onClick={() => scrollToBottom()}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M8 3v10m0 0 4-4m-4 4L4 9"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>

                <div className="kb-chat-input-dock">{composer}</div>
              </>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  onStop,
  isLoading,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isLoading: boolean;
  autoFocus: boolean;
}) {
  const canSend = value.trim().length > 0 && !isLoading;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the text up to a cap; shrink back once the message is sent.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  return (
    <div
      className={`kb-chat-input-card${isLoading ? " busy" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) textareaRef.current?.focus();
      }}
    >
      <textarea
        ref={textareaRef}
        className="kb-chat-textarea"
        placeholder="Ask about climate, biodiversity, policy…"
        aria-label="Message"
        value={value}
        rows={1}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) onSend();
          }
        }}
      />
      <div className="kb-chat-input-bottom">
        <span className="kb-chat-hint" aria-hidden="true">
          {isLoading ? (
            "Writing an answer…"
          ) : (
            <>
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for
              a new line
            </>
          )}
        </span>
        {isLoading ? (
          <button
            type="button"
            className="kb-chat-send stop"
            onClick={onStop}
            aria-label="Stop generating"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect
                x="1"
                y="1"
                width="10"
                height="10"
                rx="2"
                fill="currentColor"
              />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            className="kb-chat-send"
            onClick={onSend}
            aria-label="Send message"
            disabled={!canSend}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M8 13V3m0 0L3.5 7.5M8 3l4.5 4.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function truncate(text: string, max: number) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function TypingDots() {
  return (
    <div className="kb-chat-ai-msg">
      <div className="kb-typing">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function ChatMessage({
  message,
  isStreaming,
}: {
  message: UIMessage;
  isStreaming: boolean;
}) {
  const [showAllSources, setShowAllSources] = useState(false);
  const isUser = message.role === "user";
  const text = getMessageText(message);
  const sources = getMessageSources(message);
  const showSources =
    !isStreaming && sources.length > 0 && !shouldHideSourcesForAnswer(text);
  const visibleSources = showAllSources ? sources : sources.slice(0, 4);
  const extraSourceCount = Math.max(0, sources.length - visibleSources.length);

  if (isUser) {
    return (
      <div className="kb-chat-user-row">
        <div className="kb-chat-user-pill">{text}</div>
      </div>
    );
  }

  // Sources arrive before the first words; keep the dots until text shows up.
  if (isStreaming && !text) return <TypingDots />;

  return (
    <div className="kb-chat-ai-msg">
      <div className="kb-chat-prose">
        {renderMarkdown(text)}
        {isStreaming && <span className="kb-chat-cursor" />}
      </div>
      {showSources && (
        <div className="kb-source-cards" aria-label="Sources">
          {visibleSources.map((src, i) => (
            <a
              key={i}
              className="kb-source-card"
              href={src.url || "#"}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="kb-source-meta">
                <span className="kb-source-icon">
                  {getSourceLabel(src).slice(0, 1).toUpperCase()}
                </span>
                <span>{getSourceLabel(src)}</span>
              </span>
              <span className="kb-source-title">{truncate(src.title, 58)}</span>
            </a>
          ))}
          {extraSourceCount > 0 && !showAllSources && (
            <button
              type="button"
              className="kb-source-card kb-source-more"
              onClick={() => setShowAllSources(true)}
            >
              <span className="kb-source-more-icon">+{extraSourceCount}</span>
              <span className="kb-source-title">Show all {sources.length}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
