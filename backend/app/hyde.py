"""
HyDE (Hypothetical Document Embeddings) for query-time retrieval.

  should_use_hyde(query)        — fast decision based on query shape
  generate_hyde(llm, query)     — LLM call with retry, validation, fallback

The graph composes these: `decide_hyde` uses should_use_hyde; if yes, the
`generate_hyde` node calls the LLM. On failure (after retries), the graph
falls back to the original query — retrieval still works, just without HyDE.
"""

from __future__ import annotations

import re
import time
from typing import Optional

import structlog
from langchain_openai import ChatOpenAI

from app.config import HYDE_BASE_DELAY_MS, HYDE_ENABLED, HYDE_MAX_ATTEMPTS
from app.prompts import HYDE_PROMPT

logger = structlog.get_logger(__name__)


TECHNICAL_INDICATORS = {
    "protocol", "amendment", "convention", "fund", "ndc", "ipcc",
    "unfccc", "cop", "unep", "sdg", "gef", "kigali", "montreal",
    "paris agreement",
}


class HyDEError(Exception):
    pass


def should_use_hyde(query: str) -> bool:
    """
    Conditional HyDE: skip when the query is already specific or too short.

    HyDE helps casual paraphrased queries by generating formal text in the
    corpus's institutional voice. For queries already using technical
    vocabulary or short entity lookups, HyDE adds noise without benefit.
    """
    if not HYDE_ENABLED:
        return False
    lower = query.lower()
    if any(term in lower for term in TECHNICAL_INDICATORS):
        return False
    if len(query.split()) < 4:
        return False
    return True


def _validate_hyde(text: str) -> str:
    cleaned = text.strip()
    if len(cleaned) < 50:
        raise HyDEError("HyDE output too short")
    words = re.split(r"\s+", cleaned)
    if len(words) > 250:
        # Don't fail — truncate. Pipelines should tolerate model drift.
        return " ".join(words[:150])
    return cleaned


def generate_hyde(llm: ChatOpenAI, user_query: str) -> Optional[str]:
    """
    Generate a hypothetical answer for vector retrieval.

    Returns the validated hypothetical text on success, or None if all
    retries failed (caller falls back to the original query).
    """
    prompt = HYDE_PROMPT.replace("{USER_QUERY}", user_query)
    last_error: Optional[Exception] = None

    for attempt in range(1, HYDE_MAX_ATTEMPTS + 1):
        try:
            response = llm.invoke(prompt)
            text = getattr(response, "content", "")
            if not isinstance(text, str) or not text.strip():
                raise HyDEError("empty HyDE output")
            cleaned = _validate_hyde(text)
            logger.info(
                "hyde_generated",
                query_preview=user_query[:120],
                hyde_preview=cleaned[:200],
                attempt=attempt,
            )
            return cleaned
        except Exception as err:
            last_error = err
            if attempt == HYDE_MAX_ATTEMPTS:
                break
            time.sleep((HYDE_BASE_DELAY_MS / 1000.0) * (2 ** (attempt - 1)))

    logger.warning(
        "hyde_failed_fallback_to_original",
        error=str(last_error) if last_error else "unknown",
        attempts=HYDE_MAX_ATTEMPTS,
    )
    return None