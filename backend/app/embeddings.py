"""
Embeddings client builder + startup assertion.

We use OpenAIEmbeddings configured to point at OpenRouter. The `dimensions`
parameter is critical — Qwen3 supports configurable output sizes (32-1024).
Without explicit dims, the default may not match the index, silently
producing vectors that fail at index time.
"""

from __future__ import annotations

import structlog
from langchain_openai import OpenAIEmbeddings

from app.config import (
    EMBEDDING_DIMENSION,
    OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL,
    OPENROUTER_EMBEDDING_MODEL,
)

logger = structlog.get_logger(__name__)


def build_embeddings() -> OpenAIEmbeddings:
    if not OPENROUTER_API_KEY:
        raise ValueError("OPENROUTER_API_KEY is required for embeddings")
    return OpenAIEmbeddings(
        model=OPENROUTER_EMBEDDING_MODEL,
        dimensions=EMBEDDING_DIMENSION,
        openai_api_key=OPENROUTER_API_KEY,
        openai_api_base=OPENROUTER_BASE_URL,
        tiktoken_enabled=False,
        check_embedding_ctx_length=False,
    )


def startup_embedding_assertions(embedding_fn: OpenAIEmbeddings) -> None:
    """Fail fast if the embedding service returns the wrong dimension."""
    if EMBEDDING_DIMENSION <= 0:
        raise ValueError(f"EMBEDDING_DIMENSION must be > 0, got {EMBEDDING_DIMENSION}")
    vec = embedding_fn.embed_query("startup health check")
    if len(vec) != EMBEDDING_DIMENSION:
        raise ValueError(
            f"Embedding dimension mismatch at startup: "
            f"expected {EMBEDDING_DIMENSION}, got {len(vec)}"
        )
    logger.info(
        "embedding_startup_check_passed",
        dimension=len(vec),
        model=OPENROUTER_EMBEDDING_MODEL,
    )
