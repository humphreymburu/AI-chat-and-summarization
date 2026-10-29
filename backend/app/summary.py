"""
Summary mode (GGKP-style structured response).

Produces an audience-segmented answer with inline citations [1], [2], ...
that reference documents in a ranked list. Distinct from chat/RAG modes:

  - search   : ranked documents only
  - rag      : conversational answer + chunks for LLM context
  - summary  : structured multi-section answer + document list + stats

The summary structure has fixed audience-segmented sections so the result
is scannable and consistent across queries.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

import structlog
from langchain_core.documents import Document
from pydantic import BaseModel, Field

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

SUMMARY_PROMPT = """You are creating a structured knowledge-broker summary for \
the Green Growth Knowledge Partnership (GGKP). The user has asked a question; \
your job is to synthesize an answer from the provided source documents, with \
clearly labeled sections for different audience types.

Each section must:
- Cite source documents inline using bracketed numbers: [1], [2], [3]
- Numbers refer to the documents below in the order they appear
- Be 80-200 words long
- Be grounded in the provided sources — do not invent facts
- Use formal, authoritative tone appropriate for an intergovernmental body

If you cannot find information for a section from the sources, set that field \
to an empty string "" — do not write gap-filling or "no information" sentences.

Output strict JSON with exactly these keys, no preamble, no markdown fences:

{{
  "executive_summary": "Overall framing of the topic, 150-250 words, with citations",
  "insights_for_policymakers": "Policies, regulations, frameworks, with citations",
  "insights_for_businesses": "Market data, opportunities, case studies, with citations",
  "insights_for_financial_institutions": "Investment volumes, risks, disclosure, with citations",
  "insights_for_interested_people": "Accessible framing, key facts, what individuals should know, with citations"
}}

User question: {question}

Source documents:
{sources}

Structured summary:"""


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class SummaryStats(BaseModel):
    results_found: int
    resources_scanned: int
    relevant_knowledge_hubs: str
    search_time_seconds: float


class StructuredSummary(BaseModel):
    executive_summary: str = ""
    insights_for_policymakers: str = ""
    insights_for_businesses: str = ""
    insights_for_financial_institutions: str = ""
    insights_for_interested_people: str = ""


class SummaryDocument(BaseModel):
    citation_index: int
    title: str
    source: Optional[str] = None
    relevance_score: float
    description: str = ""
    url: Optional[str] = None
    thumbnail_url: Optional[str] = None
    publication_date: Optional[str] = None
    topics: Optional[List[str]] = None


class SummaryResponse(BaseModel):
    query: str
    stats: SummaryStats
    summary: StructuredSummary
    documents: List[SummaryDocument]


# ---------------------------------------------------------------------------
# Source formatting (for the prompt)
# ---------------------------------------------------------------------------

def format_sources_for_prompt(docs: List[Document], max_chars: int = 1200) -> str:
    """
    Format documents as numbered sources for the LLM prompt.

    Numbers here become the citation indices the LLM uses in [n] references.
    """
    blocks: List[str] = []
    for i, doc in enumerate(docs, start=1):
        title = doc.metadata.get("article_title") or "(untitled)"
        section = doc.metadata.get("section_heading") or ""
        date = doc.metadata.get("publication_date") or ""
        body = (doc.page_content or "")[:max_chars]
        header = f"[{i}] {title}"
        if section:
            header += f" — {section}"
        if date:
            header += f" ({date})"
        blocks.append(f"{header}\n{body}")
    return "\n\n".join(blocks)


# ---------------------------------------------------------------------------
# JSON parsing with fallback
# ---------------------------------------------------------------------------

_NO_INFO_PHRASES = (
    "do not contain",
    "does not contain",
    "no specific",
    "not specifically address",
    "no information",
    "not provided",
    "not available",
    "cannot provide",
    "no relevant",
    "not relevant",
    "no data",
    "no details",
    "documents do not",
    "sources do not",
    "provided documents",
    "no mention",
)


def _has_content(value: str) -> bool:
    """Return False if the LLM filled a section with a gap-acknowledgement sentence."""
    lower = value.lower()
    return bool(value) and not any(phrase in lower for phrase in _NO_INFO_PHRASES)


def _clean_field(raw: Any) -> str:
    value = str(raw).strip()
    return value if _has_content(value) else ""


def _parse_summary_json(text: str) -> StructuredSummary:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if match:
        cleaned = match.group(0)
    try:
        data = json.loads(cleaned)
        return StructuredSummary(
            executive_summary=_clean_field(data.get("executive_summary", "")),
            insights_for_policymakers=_clean_field(data.get("insights_for_policymakers", "")),
            insights_for_businesses=_clean_field(data.get("insights_for_businesses", "")),
            insights_for_financial_institutions=_clean_field(data.get("insights_for_financial_institutions", "")),
            insights_for_interested_people=_clean_field(data.get("insights_for_interested_people", "")),
        )
    except Exception as err:
        logger.warning("summary_parse_failed", error=str(err), raw=text[:300])
        # Fallback: put raw text in executive_summary so something renders.
        return StructuredSummary(
            executive_summary=text.strip()[:2000],
            insights_for_policymakers="",
            insights_for_businesses="",
            insights_for_financial_institutions="",
            insights_for_interested_people="",
        )


# ---------------------------------------------------------------------------
# Citation backfill
# ---------------------------------------------------------------------------

CITATION_RE = re.compile(r"\[(\d+)\]")


def cited_indices_from_summary(summary: StructuredSummary) -> List[int]:
    """Return citation indices referenced anywhere in the summary."""
    text = " ".join([
        summary.executive_summary,
        summary.insights_for_policymakers,
        summary.insights_for_businesses,
        summary.insights_for_financial_institutions,
        summary.insights_for_interested_people,
    ])
    return sorted({int(m.group(1)) for m in CITATION_RE.finditer(text)})


# ---------------------------------------------------------------------------
# Document conversion
# ---------------------------------------------------------------------------

def doc_to_summary_document(
    doc: Document,
    citation_index: int,
    description_max_chars: int = 500,
) -> SummaryDocument:
    """Convert a retrieval Document into the API-shape SummaryDocument."""
    md = doc.metadata or {}
    rerank = md.get("rerank_score")
    hybrid = md.get("hybrid_score")
    score = rerank if rerank is not None else hybrid
    try:
        score = float(score) if score is not None else 0.0
    except (TypeError, ValueError):
        score = 0.0
    score = max(0.0, min(1.0, score))

    description = (doc.page_content or "")[:description_max_chars].strip()
    if doc.page_content and len(doc.page_content) > description_max_chars:
        description += "..."

    topics = md.get("topics")
    if isinstance(topics, str):
        topics = [topics]
    elif not isinstance(topics, list):
        topics = None

    return SummaryDocument(
        citation_index=citation_index,
        title=md.get("article_title") or "(untitled)",
        source=md.get("site_name"),
        relevance_score=round(score, 4),
        description=description,
        url=md.get("article_url"),
        thumbnail_url=md.get("thumbnail_url"),
        publication_date=md.get("publication_date"),
        topics=topics,
    )


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

def generate_structured_summary(
    summary_llm,
    question: str,
    docs: List[Document],
    max_sources_in_prompt: int = 8,
) -> StructuredSummary:
    """Call the LLM to produce the structured five-section summary."""
    if not docs:
        return StructuredSummary(
            executive_summary=(
                "No source documents were found that match this query. "
                "Try rephrasing or broadening your terms."
            ),
        )

    prompt_docs = docs[:max_sources_in_prompt]
    sources_text = format_sources_for_prompt(prompt_docs)
    prompt = SUMMARY_PROMPT.format(question=question, sources=sources_text)

    try:
        response = summary_llm.invoke(prompt)
        text = getattr(response, "content", "") or ""
        return _parse_summary_json(text)
    except Exception as err:
        logger.warning("summary_llm_failed", error=str(err))
        return StructuredSummary(
            executive_summary=(
                "An error occurred while generating the summary. "
                "Please see the source documents below."
            ),
        )


def build_summary_response(
    question: str,
    docs: List[Document],
    summary: StructuredSummary,
    stats: SummaryStats,
    cited_only: bool = False,
) -> SummaryResponse:
    """Assemble the final response."""
    summary_docs: List[SummaryDocument] = []

    if cited_only:
        cited = set(cited_indices_from_summary(summary))
        for i, doc in enumerate(docs, start=1):
            if i not in cited:
                continue
            summary_docs.append(doc_to_summary_document(doc, citation_index=i))
    else:
        for i, doc in enumerate(docs, start=1):
            summary_docs.append(doc_to_summary_document(doc, citation_index=i))

    return SummaryResponse(
        query=question,
        stats=stats,
        summary=summary,
        documents=summary_docs,
    )


def compute_stats(
    docs: List[Document],
    total_results_found: int,
    resources_scanned: int,
    total_knowledge_hubs: int,
    elapsed_seconds: float,
) -> SummaryStats:
    """Build the stats panel from retrieval metadata."""
    hubs_hit = len({
        d.metadata.get("site_name")
        for d in docs
        if d.metadata.get("site_name")
    })
    return SummaryStats(
        results_found=total_results_found,
        resources_scanned=resources_scanned,
        relevant_knowledge_hubs=f"{hubs_hit} / {total_knowledge_hubs}",
        search_time_seconds=round(elapsed_seconds, 2),
    )