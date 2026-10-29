"""
Centralized config + request schema.

Every feature is toggleable via env. Defaults are conservative — features off
unless explicitly enabled. Required values raise on import (fail-fast).
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

load_dotenv()

from pydantic import BaseModel


def env_first(*keys: str, default: Optional[str] = None) -> Optional[str]:
    """Return the first non-empty env var from a list of fallback names."""
    for key in keys:
        value = os.getenv(key)
        if isinstance(value, str) and value.strip():
            return value
    return default


def env_bool(key: str, default: bool = False) -> bool:
    value = os.getenv(key)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# OpenSearch
# ---------------------------------------------------------------------------

OPENSEARCH_URL = env_first("V2_OPENSEARCH_SERVICE_URL", "v2_OPENSEARCH_URL")
OPENSEARCH_USERNAME = env_first(
    "V2_OPENSEARCH_USER_NAME", "v2_OPENSEARCH_USERNAME", default="admin"
)
OPENSEARCH_PASSWORD = env_first("V2_OPENSEARCH_PASSWORD", "v2_OPENSEARCH_PASSWORD")
OPENSEARCH_INDEX_NAME = env_first(
    "CHUNKS_INDEX", "v2_OPENSEARCH_INDEX_NAME", default="chunks_current"
)
OPENSEARCH_HYBRID_PIPELINE = os.getenv("OPENSEARCH_HYBRID_PIPELINE", "hybrid-pipeline")


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------

HYBRID_TOP_K = int(os.getenv("HYBRID_TOP_K", "10"))
HYBRID_RAG_K = int(os.getenv("HYBRID_RAG_K", "8"))
HYBRID_VECTOR_K = int(os.getenv("HYBRID_VECTOR_K", "50"))
METRICS_BRANCH_PROBE = env_bool("METRICS_BRANCH_PROBE")
EMBEDDING_DIMENSION = int(os.getenv("EMBEDDING_DIMENSION", "1024"))


# ---------------------------------------------------------------------------
# LLM providers
# ---------------------------------------------------------------------------

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "openrouter").lower()

# Azure (used when LLM_PROVIDER=azure)
AZURE_OPENAI_API_KEY = os.getenv("AZURE_OPENAI_API_KEY")
AZURE_OPENAI_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT")
if LLM_PROVIDER == "azure" and not AZURE_OPENAI_ENDPOINT:
    raise ValueError(
        "AZURE_OPENAI_ENDPOINT environment variable is required when "
        "LLM_PROVIDER=azure"
    )

# OpenRouter (default)
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL")
if LLM_PROVIDER == "openrouter" and not OPENROUTER_MODEL:
    raise ValueError(
        "OPENROUTER_MODEL environment variable is required when "
        "LLM_PROVIDER=openrouter"
    )

# Specialized model slots — separate so you can tune per role.
HYDE_MODEL = os.getenv("HYDE_MODEL", "anthropic/claude-haiku-4-5")
GRADING_MODEL = os.getenv("GRADING_MODEL", "anthropic/claude-haiku-4-5")
INTENT_MODEL = os.getenv("INTENT_MODEL", "anthropic/claude-haiku-4-5")
TOOL_PLANNER_MODEL = os.getenv("TOOL_PLANNER_MODEL", "anthropic/claude-haiku-4-5")

OPENROUTER_EMBEDDING_MODEL = os.getenv(
    "OPENROUTER_EMBEDDING_MODEL", "qwen/qwen3-embedding-8b"
)
STARTUP_EMBEDDING_CHECK = env_bool("STARTUP_EMBEDDING_CHECK", default=True)


# ---------------------------------------------------------------------------
# Token budgets
# ---------------------------------------------------------------------------

# Per-role caps. Set high enough that reasoning models (which emit <think>
# tokens that count against max_tokens) have headroom for actual output.
INTENT_MAX_TOKENS = int(os.getenv("INTENT_MAX_TOKENS", "500"))
GRADING_MAX_TOKENS = int(os.getenv("GRADING_MAX_TOKENS", "500"))
HYDE_MAX_TOKENS = int(os.getenv("HYDE_MAX_TOKENS", "500"))
TOOL_PLANNER_MAX_TOKENS = int(os.getenv("TOOL_PLANNER_MAX_TOKENS", "500"))

# Summary mode needs a higher budget for the five-section structured response.
SUMMARY_MAX_TOKENS = int(os.getenv("SUMMARY_MAX_TOKENS", "2048"))


# ---------------------------------------------------------------------------
# HyDE
# ---------------------------------------------------------------------------

HYDE_ENABLED = env_bool("HYDE_ENABLED")
HYDE_MAX_ATTEMPTS = int(os.getenv("HYDE_MAX_ATTEMPTS", "2"))
HYDE_BASE_DELAY_MS = int(os.getenv("HYDE_BASE_DELAY_MS", "200"))


# ---------------------------------------------------------------------------
# Intent classification
# ---------------------------------------------------------------------------

INTENT_ENABLED = env_bool("INTENT_ENABLED", default=True)


# ---------------------------------------------------------------------------
# Reranking
# ---------------------------------------------------------------------------

# Provider options: "cohere", "bge", "none"
RERANK_PROVIDER = os.getenv("RERANK_PROVIDER", "none").lower()
RERANK_ENABLED = RERANK_PROVIDER != "none"
RERANK_TOP_N = int(os.getenv("RERANK_TOP_N", "10"))

COHERE_API_KEY = os.getenv("COHERE_API_KEY")
COHERE_RERANK_MODEL = os.getenv("COHERE_RERANK_MODEL", "rerank-v3.5")

BGE_RERANK_MODEL = os.getenv("BGE_RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
BGE_API_URL = os.getenv("BGE_API_URL")
BGE_API_KEY = os.getenv("BGE_API_KEY")


# ---------------------------------------------------------------------------
# Tool calling
# ---------------------------------------------------------------------------

TOOLS_ENABLED = env_bool("TOOLS_ENABLED")

WEB_SEARCH_ENABLED = env_bool("WEB_SEARCH_ENABLED")
WEB_SEARCH_PROVIDER = os.getenv("WEB_SEARCH_PROVIDER", "tavily").lower()
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")
SERPAPI_API_KEY = os.getenv("SERPAPI_API_KEY")
BRAVE_SEARCH_API_KEY = os.getenv("BRAVE_SEARCH_API_KEY")
WEB_SEARCH_MAX_RESULTS = int(os.getenv("WEB_SEARCH_MAX_RESULTS", "5"))

CALCULATOR_ENABLED = env_bool("CALCULATOR_ENABLED", default=True)

MAX_TOOL_ITERATIONS = int(os.getenv("MAX_TOOL_ITERATIONS", "3"))


# ---------------------------------------------------------------------------
# Checkpointing
# ---------------------------------------------------------------------------

# Provider options: "none", "memory", "sqlite", "redis"
CHECKPOINT_PROVIDER = os.getenv("CHECKPOINT_PROVIDER", "none").lower()
CHECKPOINT_SQLITE_PATH = os.getenv("CHECKPOINT_SQLITE_PATH", "checkpoints.sqlite")
CHECKPOINT_REDIS_URL = os.getenv("CHECKPOINT_REDIS_URL", "redis://localhost:6379/0")


# ---------------------------------------------------------------------------
# Streaming intermediate state
# ---------------------------------------------------------------------------

STREAM_INTERMEDIATE_STATE = env_bool("STREAM_INTERMEDIATE_STATE", default=False)


# ---------------------------------------------------------------------------
# Semantic response cache (for /search summary mode)
# ---------------------------------------------------------------------------

SUMMARY_CACHE_ENABLED = env_bool("SUMMARY_CACHE_ENABLED")
SUMMARY_CACHE_INDEX = os.getenv("SUMMARY_CACHE_INDEX", "summary_cache_v1")
SUMMARY_CACHE_THRESHOLD = float(os.getenv("SUMMARY_CACHE_THRESHOLD", "0.92"))
SUMMARY_CACHE_MAX_AGE_DAYS = int(os.getenv("SUMMARY_CACHE_MAX_AGE_DAYS", "7"))


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------

# Required to call /admin/cache/flush. Send as X-Admin-Token header.
# If unset the endpoint returns 403 — force explicit configuration.
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN")

# Shared secret the Next.js app sends as X-Internal-Secret. When set, the chat,
# search and thread endpoints reject requests without it, so the API can only
# be used through the app (which applies per-user quotas). Leave unset for
# local development only.
INTERNAL_API_SECRET = os.getenv("INTERNAL_API_SECRET")


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------

# Comma-separated list of allowed origins, e.g.
# "https://app.example.org,http://localhost:3000". Defaults to "*" (any origin).
CORS_ALLOW_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOW_ORIGINS", "*").split(",")
    if origin.strip()
]


# ---------------------------------------------------------------------------
# Stats (for /search response)
# ---------------------------------------------------------------------------

DEFAULT_RESOURCES_SCANNED = int(os.getenv("DEFAULT_RESOURCES_SCANNED", "41504"))
DEFAULT_TOTAL_KNOWLEDGE_HUBS = int(os.getenv("DEFAULT_TOTAL_KNOWLEDGE_HUBS", "12"))


# ---------------------------------------------------------------------------
# Request schema
# ---------------------------------------------------------------------------

class ChatHistory(BaseModel):
    """Top-level request body for /chat endpoint."""
    question: str
    chat_history: Optional[List[Dict[str, Any]]] = None
    mode: Optional[str] = "search"             # "search" | "rag" | "summary"
    filters: Optional[Dict[str, Any]] = None
    # When checkpointing is enabled, thread_id scopes state across requests.
    thread_id: Optional[str] = None
