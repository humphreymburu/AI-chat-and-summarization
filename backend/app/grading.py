"""
Agentic helpers: relevance grading and query rewriting.

These power the adaptive retrieval loop in the graph:

  1. Retrieve N chunks
  2. Grader scores them as relevant/not_relevant
  3. If too few relevant → rewrite the query → retrieve again
  4. Otherwise proceed to answer generation
"""

from __future__ import annotations

import concurrent.futures
import json
import re
from typing import List

import structlog
from langchain_core.documents import Document
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Relevance grader
# ---------------------------------------------------------------------------

GRADER_PROMPT = """You judge whether a document is relevant to a user's question.

Question: {question}

Document title: {title}
Document section: {section}
Document content (first 800 chars):
{content}

A document is RELEVANT if it directly addresses the question or contains \
information that helps answer it. A document is NOT_RELEVANT if it is on a \
different topic, only tangentially related, or doesn't contain useful information \
for the question.

Respond with strict JSON in this exact shape, no preamble:
{{"relevant": true_or_false, "reason": "one short sentence"}}"""


class GradeResult(BaseModel):
    relevant: bool
    reason: str = Field(default="")


def _parse_grader_output(text: str) -> GradeResult:
    """
    Parse the grader LLM's JSON output, tolerating markdown fences,
    commentary, and other model drift.
    """
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if match:
        cleaned = match.group(0)
    try:
        data = json.loads(cleaned)
        return GradeResult(
            relevant=bool(data.get("relevant", False)),
            reason=str(data.get("reason", "")),
        )
    except Exception as err:
        logger.warning("grader_output_parse_failed", error=str(err), raw=text[:300])
        # Default to relevant — better to include a doc we weren't sure
        # about than to drop one wrongly.
        return GradeResult(relevant=True, reason="parse_failed_assume_relevant")


def grade_document(llm: ChatOpenAI, question: str, doc: Document) -> GradeResult:
    title = doc.metadata.get("article_title") or "(no title)"
    section = doc.metadata.get("section_heading") or "(no section)"
    content = (doc.page_content or "")[:800]

    prompt = GRADER_PROMPT.format(
        question=question,
        title=title,
        section=section,
        content=content,
    )
    response = llm.invoke(prompt)
    text = getattr(response, "content", "") or ""
    return _parse_grader_output(text)


def grade_documents(
    llm: ChatOpenAI,
    question: str,
    docs: List[Document],
    max_grade: int = 8,
) -> List[GradeResult]:
    """
    Grade up to max_grade docs in parallel.

    Uses a thread pool so all LLM calls run concurrently, reducing grading
    latency from O(n × latency) to O(latency) regardless of doc count.
    Submission order is preserved so grades align with their documents.
    """
    to_grade = docs[:max_grade]
    if not to_grade:
        return [GradeResult(relevant=True, reason="not_graded") for _ in docs]

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(to_grade)) as pool:
        futures = [
            pool.submit(grade_document, llm, question, doc)
            for doc in to_grade
        ]
        results = [f.result() for f in futures]

    # Docs beyond max_grade are assumed relevant without an LLM call.
    for _ in docs[max_grade:]:
        results.append(GradeResult(relevant=True, reason="not_graded"))
    return results


# ---------------------------------------------------------------------------
# Query rewriter
# ---------------------------------------------------------------------------

REWRITE_PROMPT = """The user asked a question that returned poor search results. \
Rewrite the question to improve retrieval from an environmental policy document library.

Rules:
- Preserve the user's intent
- Use vocabulary more likely to appear in UN policy documents
- Add specificity where the original is vague
- Stay under 25 words
- Output the rewritten question only — no preamble, no explanation

Original question: {question}
Why previous retrieval failed: {reason}

Rewritten question:"""


def rewrite_query(llm: ChatOpenAI, question: str, reason: str = "low relevance") -> str:
    prompt = REWRITE_PROMPT.format(question=question, reason=reason)
    try:
        response = llm.invoke(prompt)
        text = (getattr(response, "content", "") or "").strip()
        if not text:
            raise ValueError("empty rewrite")
        text = text.strip('"\'')
        logger.info("query_rewritten", original=question, rewritten=text)
        return text
    except Exception as err:
        logger.warning(
            "query_rewrite_failed_using_original",
            error=str(err),
            original=question,
        )
        return question