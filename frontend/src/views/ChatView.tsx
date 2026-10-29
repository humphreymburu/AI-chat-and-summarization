"use client";

import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useState, useRef, useEffect } from "react";

import KnowledgeNav from "@unep/components/KnowledgeNav";

const SUGGESTIONS = [
  "Which regions face the highest long-term drought risk?",
  "What biodiversity policies have shown measurable results?",
  "How has food security changed under climate stress since 2020?",
  "Summarise the key findings on plastic pollution in oceans.",
];

const SCOPE_CHIPS = [
  { label: "All documents", value: "all" },
  { label: "Publications only", value: "resource" },
  { label: "Last 12 months", value: "recent" },
];

type Conversation = { id: string; title: string; meta: string };

type Source = { title: string; url: string; source: string };

const CHAT_URL =
  process.env.NEXT_PUBLIC_UNEP_AI_CHAT_URL ?? "http://127.0.0.1:8000/chat/ui";

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

export default function ChatPage() {
  const [activeScope, setActiveScope] = useState("all");
  const [activeCid, setActiveCid] = useState(createConversationId);
  const [conversations, setConversations] = useState<Conversation[]>(() => [
    { id: activeCid, title: "New conversation", meta: "Today · 0 messages" },
  ]);
  const [input, setInput] = useState("");

  // One Chat per conversation, so switching back keeps its messages and an
  // answer can finish streaming in the background. The chat id is sent as
  // `id` and the backend uses it as the thread id.
  const [transport] = useState(
    () => new DefaultChatTransport<UIMessage>({ api: CHAT_URL })
  );
  const [chats] = useState(() => new Map<string, Chat<UIMessage>>());
  const getChat = (id: string) => {
    let chat = chats.get(id);
    if (!chat) {
      chat = new Chat({ id, transport });
      chats.set(id, chat);
    }
    return chat;
  };

  const { messages, sendMessage, status, stop, error, regenerate } = useChat({
    chat: getChat(activeCid),
  });
  const isLoading = status === "submitted" || status === "streaming";

  const msgsEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // A conversation's title and count come from its messages once it has any.
  const describeConversation = (c: Conversation): Conversation => {
    const msgs = c.id === activeCid ? messages : chats.get(c.id)?.messages ?? [];
    const firstUser = msgs.find((m) => m.role === "user");
    if (!firstUser) return c;
    return {
      ...c,
      title: truncate(getMessageText(firstUser), 36),
      meta: `Today · ${msgs.length} message${msgs.length !== 1 ? "s" : ""}`,
    };
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    sendMessage({ text }, { body: { scope: activeScope } });
  };

  const handleNewConversation = () => {
    const id = createConversationId();
    setConversations((prev) => [
      { id, title: "New conversation", meta: "Just now · 0 messages" },
      ...prev,
    ]);
    setActiveCid(id);
    setInput("");
  };

  const handleSelectConversation = (id: string) => {
    if (id === activeCid) return;
    setActiveCid(id);
    setInput("");
  };

  return (
    <>
      <div className="kb-root">
        <KnowledgeNav />

        <div className="kb-chat-page">
          <div className="kb-chat-layout">
            {/* ── Sidebar ── */}
            <div className="kb-chat-sidebar">
              <div className="kb-cs-header">
                <span className="kb-cs-title">Conversations</span>
                <button className="kb-cs-new" onClick={handleNewConversation}>
                  + New
                </button>
              </div>
              <div className="kb-cs-list">
                {conversations.map(describeConversation).map((c) => (
                  <div
                    key={c.id}
                    className={`kb-cs-item${
                      c.id === activeCid ? " active" : ""
                    }`}
                    onClick={() => handleSelectConversation(c.id)}
                  >
                    <div className="kb-cs-item-title">{c.title}</div>
                    <div className="kb-cs-item-meta">{c.meta}</div>
                  </div>
                ))}
              </div>
              <div className="kb-cs-scope">
                <div className="kb-cs-scope-label">Search scope</div>
                {SCOPE_CHIPS.map(({ label, value }) => (
                  <button
                    key={value}
                    className={`kb-cs-chip${
                      activeScope === value ? " on" : ""
                    }`}
                    onClick={() => setActiveScope(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Main chat area ── */}
            <div className="kb-chat-main">
              {/* Messages */}
              <div className="kb-chat-msgs">
                {/* Date separator */}
                <div className="kb-chat-date-sep">Today</div>

                {/* Welcome message */}
                {messages.length === 0 && (
                  <div className="kb-chat-ai-msg">
                    <div className="kb-chat-prose">
                      <p className="kb-chat-prose-p">
                        Hello — I have access to{" "}
                        <strong>10,000+ documents</strong> in our environmental
                        library. Ask me anything about climate, biodiversity,
                        policy, or any other topic covered in the archive.
                      </p>
                    </div>
                  </div>
                )}

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

                {isLoading &&
                  (messages.length === 0 ||
                    messages[messages.length - 1].role === "user") && (
                    <TypingDots />
                  )}

                {error && !isLoading && (
                  <div className="kb-chat-error" role="alert">
                    <span>Something went wrong: {error.message}</span>
                    <button
                      className="kb-chat-error-retry"
                      onClick={() => regenerate()}
                    >
                      Retry
                    </button>
                  </div>
                )}

                <div ref={msgsEndRef} />
              </div>

              {/* Suggestion chips — shown before first message */}
              {messages.length === 0 && (
                <div className="kb-chat-suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      className="kb-csugg"
                      onClick={() =>
                        sendMessage(
                          { text: s },
                          { body: { scope: activeScope } }
                        )
                      }
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}

              {/* Input card */}
              <div className="kb-chat-input-card">
                <textarea
                  ref={inputRef}
                  className="kb-chat-textarea"
                  placeholder="Message Environment Knowledge…"
                  value={input}
                  rows={1}
                  onChange={(e) => {
                    setInput(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = `${Math.min(
                      e.target.scrollHeight,
                      140
                    )}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  disabled={isLoading}
                />
                <div className="kb-chat-input-bottom">
                  <button className="kb-chat-input-plus" title="Attach">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M8 3v10M3 8h10"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                  <select
                    className="kb-chat-scope-select"
                    value={activeScope}
                    onChange={(e) => setActiveScope(e.target.value)}
                  >
                    {SCOPE_CHIPS.map(({ label, value }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <div style={{ flex: 1 }} />
                  {isLoading ? (
                    <button
                      className="kb-chat-send"
                      onClick={stop}
                      title="Stop"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                      >
                        <rect
                          x="3"
                          y="3"
                          width="8"
                          height="8"
                          rx="1.5"
                          fill="#fff"
                        />
                      </svg>
                    </button>
                  ) : (
                    <button
                      className="kb-chat-send"
                      onClick={handleSend}
                      title="Send"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                      >
                        <path
                          d="M2 7h10M8 3l4 4-4 4"
                          stroke="#fff"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
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
  const isUser = message.role === "user";
  const text = getMessageText(message);
  const sources = getMessageSources(message);
  const showSources =
    !isStreaming && sources.length > 0 && !shouldHideSourcesForAnswer(text);
  const visibleSources = sources.slice(0, 4);
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
              <span className="kb-source-title">
                {truncate(src.title, 58)}
              </span>
            </a>
          ))}
          {extraSourceCount > 0 && (
            <div
              className="kb-source-card kb-source-more"
              title={`${sources.length} sources`}
            >
              <span className="kb-source-more-icon">{sources.length}</span>
              <span className="kb-source-title">Show all</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
