"use client";

import axios from "axios";
import { useRouter } from "next/navigation";
import { useState } from "react";
import AppShell from "@unep/components/AppShell";
import { saveChatSeed } from "@unep/lib/chat-seed";
import type {
  SummaryDocument,
  SummaryResponse,
  StructuredSummary,
} from "@unep/lib/summary-types";

// ── Constants ───────────────────────────────────────────────────────────────

const SCOPE_CHIPS = [
  { label: "All documents", value: "all" },
  { label: "Publications only", value: "resource" },
  { label: "Last 12 months", value: "recent" },
  { label: "Policy docs", value: "policy" },
];

const SUMMARY_SECTIONS: { label: string; key: keyof StructuredSummary }[] = [
  { label: "Executive Summary", key: "executive_summary" },
  { label: "Insights for Policymakers", key: "insights_for_policymakers" },
  { label: "Insights for Businesses", key: "insights_for_businesses" },
  {
    label: "Insights for Financial Institutions",
    key: "insights_for_financial_institutions",
  },
  {
    label: "Insights for the General Public",
    key: "insights_for_interested_people",
  },
];

const SAMPLE_QUESTIONS = [
  "What adaptation policies have been most effective in coastal regions?",
  "How has food security changed under climate stress since 2020?",
  "Summarise international agreements on marine biodiversity.",
  "What are the projected carbon emission trends for G20 nations?",
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(value?: string) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function deduplicateDocuments(docs: SummaryDocument[]): SummaryDocument[] {
  const seen = new Map<string, SummaryDocument>();
  for (const doc of docs) {
    const key = doc.url || doc.title;
    const existing = seen.get(key);
    if (!existing || doc.relevance_score > existing.relevance_score) {
      seen.set(key, doc);
    }
  }
  return Array.from(seen.values());
}

// ── Sub-components ───────────────────────────────────────────────────────────

// Short tab labels for the five audience views.
const TAB_LABELS: Record<keyof StructuredSummary, string> = {
  executive_summary: "Overview",
  insights_for_policymakers: "Policymakers",
  insights_for_businesses: "Business",
  insights_for_financial_institutions: "Finance",
  insights_for_interested_people: "General public",
};

function matchLabel(score: number) {
  if (score >= 0.5) return "Strong match";
  if (score >= 0.3) return "Good match";
  return "Partial match";
}

/** Renders [1] or [1, 2] markers as links to the numbered source list. */
function CitedText({
  text,
  sourceFor,
}: {
  text: string;
  sourceFor: (index: number) => number | undefined;
}) {
  const parts = text.split(/(\[\d+(?:\s*,\s*\d+)*\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/);
        if (!match) return <span key={i}>{part}</span>;
        const numbers = match[1].split(",").map((n) => Number(n.trim()));
        return (
          <span key={i} className="kb-cite-group">
            {numbers.map((n, j) => {
              const target = sourceFor(n);
              return target === undefined ? (
                <span key={j} className="kb-cite">
                  {n}
                </span>
              ) : (
                <a
                  key={j}
                  className="kb-cite"
                  href={`#source-${target}`}
                  aria-label={`Source ${n}`}
                >
                  {n}
                </a>
              );
            })}
          </span>
        );
      })}
    </>
  );
}

function SummaryAnswer({
  summary,
  sourceFor,
}: {
  summary: StructuredSummary;
  sourceFor: (index: number) => number | undefined;
}) {
  const tabs = SUMMARY_SECTIONS.filter(({ key }) => summary[key]);
  const [active, setActive] = useState(tabs[0]?.key);
  if (tabs.length === 0) return null;

  const move = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length].key;
    setActive(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <section className="kb-answer" aria-label="Summary">
      <div className="kb-answer-tabs" role="tablist" aria-label="Audience">
        {tabs.map(({ key }, i) => (
          <button
            key={key}
            id={`tab-${key}`}
            type="button"
            role="tab"
            aria-selected={active === key}
            aria-controls={`panel-${key}`}
            tabIndex={active === key ? 0 : -1}
            className={`kb-answer-tab${active === key ? " on" : ""}`}
            onClick={() => setActive(key)}
            onKeyDown={(e) => move(e, i)}
          >
            {TAB_LABELS[key]}
          </button>
        ))}
      </div>
      {tabs.map(({ label, key }) => (
        <div
          key={key}
          id={`panel-${key}`}
          role="tabpanel"
          aria-labelledby={`tab-${key}`}
          hidden={active !== key}
          className="kb-answer-panel"
        >
          <h2 className="kb-answer-heading">{label}</h2>
          <p className="kb-answer-text">
            <CitedText text={summary[key]} sourceFor={sourceFor} />
          </p>
        </div>
      ))}
      <p className="kb-answer-caveat">
        Generated by AI from the sources below. Check the sources before relying
        on it.
      </p>
    </section>
  );
}

function SourceList({ documents }: { documents: SummaryDocument[] }) {
  return (
    <section className="kb-sources" aria-label="Sources">
      <h2 className="kb-sources-title">Sources</h2>
      <ol className="kb-source-list">
        {documents.map((doc) => (
          <li
            key={`${doc.citation_index}-${doc.title}`}
            id={`source-${doc.citation_index}`}
            className="kb-source-item"
          >
            <span className="kb-source-num">{doc.citation_index}</span>
            <div className="kb-source-main">
              {doc.url ? (
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noreferrer"
                  className="kb-source-link"
                >
                  {doc.title}
                </a>
              ) : (
                <span className="kb-source-link">{doc.title}</span>
              )}
              <div className="kb-source-meta">
                {[
                  doc.source,
                  formatDate(doc.publication_date),
                  matchLabel(doc.relevance_score),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {doc.description ? (
                <p className="kb-source-desc">{doc.description}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Shaped like the result (basis line, audience tabs, answer, sources) so the
// page doesn't jump when it arrives.
function LoadingSkeleton() {
  return (
    <div className="kb-results-wrap" role="status" aria-busy="true">
      <p className="kb-sum-wait kb-skel-wait">
        Reading the documents and writing your summary. This can take up to a
        minute.
      </p>
      <span
        className="kb-skeleton kb-skel-line kb-skel-basis"
        aria-hidden="true"
      />
      <section className="kb-answer" aria-hidden="true">
        <div className="kb-answer-tabs">
          {[72, 96, 64, 60, 104].map((w, i) => (
            <span key={i} className="kb-skel-tab">
              <span className="kb-skeleton kb-skel-line" style={{ width: w }} />
            </span>
          ))}
        </div>
        <div className="kb-answer-panel kb-skel-stack-lg">
          <span className="kb-skeleton kb-skel-heading" />
          {[100, 96, 92, 98, 70].map((w, i) => (
            <span
              key={i}
              className="kb-skeleton kb-skel-text"
              style={{ width: `${w}%` }}
            />
          ))}
        </div>
      </section>
      <section className="kb-sources" aria-hidden="true">
        <span className="kb-skeleton kb-skel-heading kb-skel-short" />
        <ol className="kb-source-list">
          {[78, 62, 70].map((w, i) => (
            <li key={i} className="kb-source-item">
              <span className="kb-skeleton kb-skel-num" />
              <span className="kb-skel-stack kb-skel-grow">
                <span
                  className="kb-skeleton kb-skel-line"
                  style={{ width: `${w}%` }}
                />
                <span className="kb-skeleton kb-skel-line kb-skel-sm" />
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SummaryPage({ signedIn }: { signedIn?: boolean }) {
  const [query, setQuery] = useState("");
  const [activeScope, setActiveScope] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [scopeUsed, setScopeUsed] = useState("all");
  const router = useRouter();

  // Documents without duplicates, keeping the numbers the answer cites.
  const uniqueDocs = data ? deduplicateDocuments(data.documents ?? []) : [];
  const sourceFor = (index: number) => {
    const doc = data?.documents?.find((d) => d.citation_index === index);
    if (!doc) return undefined;
    const key = doc.url || doc.title;
    return uniqueDocs.find((d) => (d.url || d.title) === key)?.citation_index;
  };

  const handleFollowUp = () => {
    if (!data) return;
    saveChatSeed(data);
    router.push("/chat");
  };

  const handleSummarise = async (q?: string) => {
    const kw = (q ?? query).trim();
    if (!kw) return;
    setQuery(kw);
    setLoading(true);
    setError("");
    setData(null);
    try {
      const res = await axios.post("/api/summary", {
        query: kw,
        scope: activeScope,
      });
      setData(res.data as SummaryResponse);
      setScopeUsed(activeScope);
    } catch (err) {
      // Server errors carry raw technical text, so only show messages the app
      // wrote itself (daily limit, question too long) and use plain wording
      // for everything else.
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const message =
        axios.isAxiosError<{ error?: string }>(err) &&
        status !== undefined &&
        status < 500
          ? err.response?.data?.error
          : undefined;
      setError(
        message ??
          "We couldn't get a summary right now. Your question is still here. Please try again."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <AppShell signedIn={signedIn}>
        <div className="kb-wrap">
          {/* ── Hero + input — single centred column ── */}
          <div className="kb-summary-hero">
            <h1 className="kb-sum-title">AI Summary</h1>
            <p className="kb-sum-lede">
              Ask a research question and get a cited summary drawn from the
              document library.
            </p>

            <div className="kb-sum-box">
              <div className="kb-sum-top">
                <span className="kb-sum-spark">✦</span>
                <input
                  className="kb-sum-input"
                  type="text"
                  aria-label="Research question"
                  placeholder="What are the main drivers of biodiversity loss?"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSummarise()}
                />
                <button
                  className="kb-chat-send"
                  onClick={() => handleSummarise()}
                  disabled={loading || !query.trim()}
                  title="Summarise"
                  aria-label={loading ? "Summarising" : "Summarise"}
                >
                  {loading ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle
                        cx="7"
                        cy="7"
                        r="5"
                        stroke="rgba(255,255,255,0.4)"
                        strokeWidth="2"
                      />
                      <path
                        d="M7 2a5 5 0 0 1 5 5"
                        stroke="#fff"
                        strokeWidth="2"
                        strokeLinecap="round"
                      >
                        <animateTransform
                          attributeName="transform"
                          type="rotate"
                          from="0 7 7"
                          to="360 7 7"
                          dur="0.7s"
                          repeatCount="indefinite"
                        />
                      </path>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path
                        d="M2 7h10M8 3l4 4-4 4"
                        stroke="#fff"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </div>
              <div className="kb-chips-row">
                <span className="kb-chips-label">Scope:</span>
                {SCOPE_CHIPS.map(({ label, value }) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={activeScope === value}
                    className={`kb-tag${activeScope === value ? " on" : ""}`}
                    onClick={() => setActiveScope(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {error && !loading && (
              <div className="kb-chat-error" role="alert">
                <span>{error}</span>
                <button
                  type="button"
                  className="kb-chat-error-retry"
                  onClick={() => handleSummarise()}
                >
                  Try again
                </button>
              </div>
            )}

            {/* Sample questions — shown before first search */}
            {!data && !loading && (
              <div style={{ marginTop: 24 }}>
                <div className="kb-suggest-label">Try a sample question</div>
                <div className="kb-suggest-grid">
                  {SAMPLE_QUESTIONS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="kb-suggest-card"
                      onClick={() => handleSummarise(q)}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Results area (full width below hero) ── */}
          {loading && <LoadingSkeleton />}

          {data && !loading && (
            <div className="kb-results-wrap">
              <p className="kb-answer-basis">
                Based on {uniqueDocs.length} document
                {uniqueDocs.length !== 1 ? "s" : ""}
                {data.stats?.resources_scanned
                  ? ` from ${data.stats.resources_scanned.toLocaleString()} searched`
                  : ""}
                {" · "}
                {SCOPE_CHIPS.find((c) => c.value === scopeUsed)?.label ??
                  "All documents"}
              </p>

              {data.summary && (
                <SummaryAnswer summary={data.summary} sourceFor={sourceFor} />
              )}

              {uniqueDocs.length > 0 && <SourceList documents={uniqueDocs} />}

              <div className="kb-results-actions">
                <button
                  type="button"
                  className="kb-tag"
                  onClick={handleFollowUp}
                >
                  Ask a follow-up in Chat →
                </button>
              </div>
            </div>
          )}
        </div>
      </AppShell>
    </>
  );
}
