"use client";

import axios from "axios";
import Link from "next/link";
import { useState } from "react";
import type {
  SummaryDocument,
  SummaryResponse,
  SummaryStats,
  StructuredSummary,
} from "@unep/bundles/search/results/summary-types";
import KnowledgeNav from "@unep/components/KnowledgeNav";

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
  {
    q: "What adaptation policies have been most effective in coastal regions?",
    n: 23,
  },
  {
    q: "How has food security changed under climate stress since 2020?",
    n: 61,
  },
  { q: "Summarise international agreements on marine biodiversity.", n: 38 },
  { q: "What are the projected carbon emission trends for G20 nations?", n: 44 },
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

function scorePercent(score: number) {
  return Math.max(0, Math.min(100, Math.round(score * 100)));
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

function StatsGrid({ stats }: { stats: SummaryStats }) {
  const cards = [
    { icon: "⊕", value: stats.results_found, label: "Results found" },
    {
      icon: "◈",
      value: stats.resources_scanned.toLocaleString(),
      label: "Resources scanned",
    },
    {
      icon: "⬡",
      value: stats.relevant_knowledge_hubs,
      label: "Knowledge hubs",
    },
    { icon: "◷", value: `${stats.search_time_seconds}s`, label: "Search time" },
  ];
  return (
    <div className="kb-sum-stats-grid">
      {cards.map(({ icon, value, label }) => (
        <div key={label} className="kb-sum-stat-card">
          <div className="kb-sum-stat-icon">{icon}</div>
          <div className="kb-sum-stat-val">{value}</div>
          <div className="kb-sum-stat-lbl">{label}</div>
        </div>
      ))}
    </div>
  );
}

function SummarySections({
  query,
  summary,
}: {
  query: string;
  summary: StructuredSummary;
}) {
  return (
    <div className="kb-sum-result-box" style={{ marginBottom: 20 }}>
      <div className="kb-sum-result-heading">
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#3A7D52",
            display: "inline-block",
          }}
        />
        AI-Generated Response
      </div>
      <div className="kb-sum-result-query">{query}</div>
      <div className="kb-sum-section-body">
        {SUMMARY_SECTIONS.map(({ label, key }) =>
          summary[key] ? (
            <p key={key} style={{ marginBottom: 12 }}>
              <strong style={{ fontWeight: 600, color: "#3A7D52" }}>
                {label}:{" "}
              </strong>
              {summary[key]}
            </p>
          ) : null
        )}
      </div>
    </div>
  );
}

function DocumentList({ documents }: { documents: SummaryDocument[] }) {
  const unique = deduplicateDocuments(documents);
  return (
    <div className="kb-sum-result-box">
      <div className="kb-doc-list-head">
        <span style={{ fontSize: 16 }}>◫</span>
        <span className="kb-doc-list-title">Search Results</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#bbb" }}>
          {unique.length} document{unique.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="kb-doc-list">
        {unique.map((doc) => {
          const score = scorePercent(doc.relevance_score);
          return (
            <article
              key={`${doc.citation_index}-${doc.title}`}
              className="kb-doc-card"
            >
              <div className="kb-doc-thumb">
                {doc.thumbnail_url ? (
                  <img src={doc.thumbnail_url} alt={doc.title} />
                ) : (
                  <span>◫</span>
                )}
              </div>
              <div className="kb-doc-body">
                {doc.url ? (
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noreferrer"
                    className="kb-doc-title"
                  >
                    {doc.title}
                  </a>
                ) : (
                  <div className="kb-doc-title">{doc.title}</div>
                )}
                <div className="kb-doc-meta">
                  {[doc.source, formatDate(doc.publication_date)]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                <div className="kb-doc-relevance-bar">
                  <div
                    className="kb-doc-relevance-fill"
                    style={{ width: `${score}%` }}
                  />
                </div>
                {doc.topics?.length ? (
                  <div className="kb-doc-topics">
                    {doc.topics.map((topic) => (
                      <span key={topic} className="kb-doc-topic">
                        {topic}
                      </span>
                    ))}
                  </div>
                ) : null}
                <p className="kb-doc-description">{doc.description}</p>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div>
      {/* Stats skeleton */}
      <div className="kb-sum-stats-grid" style={{ marginBottom: 20 }}>
        {[...Array(4)].map((_, i) => (
          <div key={i} className="kb-sum-stat-card">
            <div
              className="kb-skeleton"
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                marginBottom: 8,
              }}
            />
            <div
              className="kb-skeleton"
              style={{ width: "55%", height: 22, marginBottom: 6 }}
            />
            <div className="kb-skeleton" style={{ width: "70%", height: 10 }} />
          </div>
        ))}
      </div>
      {/* Summary skeleton */}
      <div className="kb-sum-result-box" style={{ marginBottom: 20 }}>
        <div
          className="kb-skeleton"
          style={{ width: "40%", height: 20, marginBottom: 16 }}
        />
        {[100, 90, 75, 85, 70, 60, 80].map((w, i) => (
          <div
            key={i}
            className="kb-skeleton"
            style={{ width: `${w}%`, height: 11, marginBottom: 8 }}
          />
        ))}
      </div>
      {/* Docs skeleton */}
      <div className="kb-sum-result-box">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="kb-doc-card">
            <div
              className="kb-skeleton kb-doc-thumb"
              style={{ background: "#D6EFE0" }}
            />
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div
                className="kb-skeleton"
                style={{ height: 14, width: "70%" }}
              />
              <div
                className="kb-skeleton"
                style={{ height: 10, width: "35%" }}
              />
              <div
                className="kb-skeleton"
                style={{ height: 3, width: "100%" }}
              />
              <div
                className="kb-skeleton"
                style={{ height: 11, width: "90%" }}
              />
              <div
                className="kb-skeleton"
                style={{ height: 11, width: "75%" }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SummaryPage() {
  const [query, setQuery] = useState("");
  const [activeScope, setActiveScope] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<SummaryResponse | null>(null);

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
    } catch (err) {
      const message = axios.isAxiosError<{ error?: string }>(err)
        ? err.response?.data?.error
        : undefined;
      setError(message ?? "Summary unavailable. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="kb-root">
        <KnowledgeNav />

        <div className="kb-wrap">
          {/* ── Hero + input — single centred column ── */}
          <div className="kb-summary-hero">
            <div className="kb-eyebrow" style={{ textAlign: "center" }}>
              02 — AI Summary
            </div>
            <h1
              className="kb-h1"
              style={{ textAlign: "center", marginBottom: 10 }}
            >
              Understand, <em>not just find.</em>
            </h1>
            <p
              className="kb-sub"
              style={{
                textAlign: "center",
                maxWidth: 480,
                margin: "0 auto 32px",
              }}
            >
              Ask a research question in plain language. The AI reads hundreds
              of matching documents and returns a concise, cited answer — in
              seconds.
            </p>

            <div className="kb-sum-box">
              <div className="kb-sum-top">
                <span className="kb-sum-spark">✦</span>
                <input
                  className="kb-sum-input"
                  placeholder="What are the main drivers of biodiversity loss?"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSummarise()}
                />
                <button
                  className="kb-chat-send"
                  onClick={() => handleSummarise()}
                  disabled={loading}
                  title="Summarise"
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
                    className={`kb-tag${activeScope === value ? " on" : ""}`}
                    onClick={() => setActiveScope(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="kb-sum-footer-row">
                <span className="kb-sum-hint">
                  The AI reads matching documents and returns a cited synthesis.
                </span>
                <span className="kb-sum-credit">Powered by Claude</span>
              </div>
            </div>

            {/* Sample questions — shown before first search */}
            {!data && !loading && (
              <div style={{ marginTop: 24 }}>
                <div
                  className="kb-suggest-label"
                  style={{ textAlign: "center" }}
                >
                  Try a sample question
                </div>
                <div className="kb-suggest-grid">
                  {SAMPLE_QUESTIONS.map(({ q, n }) => (
                    <div
                      key={q}
                      className="kb-suggest-card"
                      onClick={() => handleSummarise(q)}
                    >
                      <p>&ldquo;{q}&rdquo;</p>
                      <span>{n} matching documents</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Results area (full width below hero) ── */}
          {loading && <LoadingSkeleton />}

          {error && !loading && (
            <div
              style={{
                background: "#fff",
                borderRadius: 16,
                padding: "20px 24px",
                border: "0.5px solid rgba(0,0,0,0.09)",
                color: "#e8394e",
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}

          {data && !loading && (
            <div className="kb-results-wrap">
              {/* 4-card stats strip */}
              {data.stats && <StatsGrid stats={data.stats} />}

              {/* All five summary sections expanded */}
              {data.summary && (
                <SummarySections query={data.query} summary={data.summary} />
              )}

              {/* Document results with thumbnail, relevance bar, topics */}
              {data.documents?.length > 0 && (
                <DocumentList documents={data.documents} />
              )}

              {/* Action bar */}
              <div className="kb-results-actions">
                <Link
                  href="/chat"
                  className="kb-tag"
                  style={{ textDecoration: "none" }}
                >
                  ✦ Ask a follow-up in Chat →
                </Link>
                <Link
                  href="/search"
                  className="kb-tag"
                  style={{ textDecoration: "none" }}
                >
                  Browse all source docs →
                </Link>
              </div>
            </div>
          )}
        </div>

        <KbFooter />
      </div>
    </>
  );
}

function KbFooter() {
  return (
    <>
      <footer className="kb-footer">
        <div>
          <div className="kb-ft-brand">
            Eco<span>Buddy</span>
          </div>
          <div className="kb-ft-tag">
            Research at the speed
            <br />
            of curiosity.
          </div>
        </div>
        <div className="kb-ft-col">
          <h5>Navigate</h5>
          <ul>
            <li>
              <Link href="/search">Search</Link>
            </li>
            <li>
              <Link href="/summary">AI Summary</Link>
            </li>
            <li>
              <Link href="/chat">Chat</Link>
            </li>
          </ul>
        </div>
        <div className="kb-ft-col">
          <h5>Platform</h5>
          <ul>
            <li>
              <a href="#">API access</a>
            </li>
            <li>
              <a href="#">Embed search</a>
            </li>
          </ul>
        </div>
        <div className="kb-ft-col">
          <h5>Legal</h5>
          <ul>
            <li>
              <a href="#">Privacy policy</a>
            </li>
            <li>
              <a href="#">Terms of use</a>
            </li>
            <li>
              <a href="#">Contact</a>
            </li>
          </ul>
        </div>
      </footer>
      <div className="kb-footer-bar">
        <span>© {new Date().getFullYear()} Environment Knowledge Platform.</span>
        <span>Built for researchers, policymakers, and curious minds.</span>
      </div>
    </>
  );
}
