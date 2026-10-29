"""
Semantic response cache for /search summaries.

Pattern:
  1. Embed the incoming query
  2. Vector-search a cache index of previous (query, SummaryResponse) pairs
  3. Return cached response if similarity > threshold AND entry is fresh

Cache hit  → ~50ms (one OpenSearch knn query)
Cache miss → normal RAG pipeline runs, result stored for next time

Lives in its own OpenSearch index (`summary_cache_v1`) — can be flushed
independently of `chunks_v1`. Uses the same embedding model and dimension
as the corpus.

Disabled by default. Enable via SUMMARY_CACHE_ENABLED=true.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import structlog
from langchain_openai import OpenAIEmbeddings
from opensearchpy import OpenSearch

from app.config import (
    SUMMARY_CACHE_ENABLED,
    SUMMARY_CACHE_INDEX,
    SUMMARY_CACHE_MAX_AGE_DAYS,
    SUMMARY_CACHE_THRESHOLD,
)
from app.summary import (
    StructuredSummary,
    SummaryDocument,
    SummaryResponse,
    SummaryStats,
)

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Filter normalization
# ---------------------------------------------------------------------------

def _hash_filters(filters: Optional[Dict[str, Any]]) -> str:
    """
    Produce a stable hash so semantically-equal filters produce equal hashes.
    Drops None values, sorts keys, lowercases string values.
    """
    if not filters:
        return "none"

    normalized: Dict[str, Any] = {}
    for k in sorted(filters.keys()):
        v = filters[k]
        if v is None:
            continue
        if isinstance(v, str):
            v = v.lower()
        elif isinstance(v, list):
            v = sorted(str(x).lower() for x in v)
        normalized[k] = v

    serialized = json.dumps(normalized, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Cache class
# ---------------------------------------------------------------------------

class SummaryResponseCache:
    def __init__(
        self,
        client: OpenSearch,
        embedding_function: OpenAIEmbeddings,
        index: str = SUMMARY_CACHE_INDEX,
        threshold: float = SUMMARY_CACHE_THRESHOLD,
        max_age_days: int = SUMMARY_CACHE_MAX_AGE_DAYS,
    ):
        self.client = client
        self.embedding_function = embedding_function
        self.index = index
        self.threshold = threshold
        self.max_age_days = max_age_days
        self._hits = 0
        self._misses = 0
        self._stores = 0
        self._lookup_latency_samples: List[int] = []

    def lookup(
        self,
        query: str,
        filters: Optional[Dict[str, Any]] = None,
    ) -> Optional[SummaryResponse]:
        """Return a cached SummaryResponse or None. Cache errors return None."""
        if not SUMMARY_CACHE_ENABLED:
            return None

        t0 = time.perf_counter()
        try:
            query_vec = self.embedding_function.embed_query(query)
            filters_hash = _hash_filters(filters)

            body = {
                "size": 1,
                "query": {
                    "bool": {
                        "must": [{"knn": {"query_embedding": {"vector": query_vec, "k": 5}}}],
                        "filter": [
                            {"term": {"filters_hash": filters_hash}},
                            {"range": {
                                "created_at": {"gte": f"now-{self.max_age_days}d"}
                            }},
                        ],
                    }
                },
                "_source": ["query", "summary_response", "created_at", "hit_count"],
            }

            response = self.client.search(index=self.index, body=body)
        except Exception as err:
            # Cache failures must never break a request.
            logger.warning("summary_cache_lookup_failed", error=str(err))
            return None

        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        self._record_latency(elapsed_ms)

        hits = response.get("hits", {}).get("hits", []) or []
        if not hits:
            self._misses += 1
            return None

        top = hits[0]
        score = float(top.get("_score") or 0.0)

        if score < self.threshold:
            self._misses += 1
            logger.info(
                "summary_cache_miss_below_threshold",
                top_score=score,
                threshold=self.threshold,
                query_preview=query[:120],
            )
            return None

        self._hits += 1
        try:
            asyncio.get_running_loop().create_task(self._increment_hits(top["_id"]))
        except RuntimeError:
            pass

        source = top.get("_source", {}) or {}
        logger.info(
            "summary_cache_hit",
            score=round(score, 4),
            cached_query=source.get("query", "")[:120],
            new_query=query[:120],
            previous_hits=source.get("hit_count", 0),
            lookup_ms=elapsed_ms,
        )

        return _dict_to_summary_response(source.get("summary_response") or {})

    def store(
        self,
        query: str,
        filters: Optional[Dict[str, Any]],
        response: SummaryResponse,
    ) -> None:
        """Store a (query, response) pair. Errors logged, not raised."""
        if not SUMMARY_CACHE_ENABLED:
            return

        try:
            query_vec = self.embedding_function.embed_query(query)
            filters_hash = _hash_filters(filters)

            self.client.index(
                index=self.index,
                body={
                    "query": query,
                    "query_embedding": query_vec,
                    "summary_response": response.model_dump(),
                    "filters_hash": filters_hash,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "hit_count": 0,
                },
            )
            self._stores += 1
            logger.info(
                "summary_cache_stored",
                query_preview=query[:120],
                filters_hash=filters_hash,
            )
        except Exception as err:
            logger.warning("summary_cache_store_failed", error=str(err))

    def stats(self) -> Dict[str, Any]:
        total = self._hits + self._misses
        hit_rate = round(self._hits / total, 4) if total > 0 else 0.0

        lat = sorted(self._lookup_latency_samples)
        if lat:
            p50 = lat[len(lat) // 2]
            p95 = lat[int(len(lat) * 0.95)] if len(lat) > 1 else lat[0]
        else:
            p50 = p95 = 0

        return {
            "enabled": SUMMARY_CACHE_ENABLED,
            "hits_total": self._hits,
            "misses_total": self._misses,
            "stores_total": self._stores,
            "hit_rate": hit_rate,
            "lookup_latency_p50_ms": p50,
            "lookup_latency_p95_ms": p95,
            "threshold": self.threshold,
            "max_age_days": self.max_age_days,
        }

    def flush(self) -> Dict[str, Any]:
        """Delete all cache entries. Useful after re-indexing the corpus."""
        try:
            response = self.client.delete_by_query(
                index=self.index,
                body={"query": {"match_all": {}}},
            )
            logger.info("summary_cache_flushed", deleted=response.get("deleted", 0))
            return {
                "deleted": response.get("deleted", 0),
                "took_ms": response.get("took", 0),
            }
        except Exception as err:
            logger.warning("summary_cache_flush_failed", error=str(err))
            return {"error": str(err)}

    def _record_latency(self, ms: int) -> None:
        self._lookup_latency_samples.append(ms)
        if len(self._lookup_latency_samples) > 200:
            del self._lookup_latency_samples[:-200]

    async def _increment_hits(self, doc_id: str) -> None:
        try:
            self.client.update(
                index=self.index,
                id=doc_id,
                body={
                    "script": {
                        "source": "ctx._source.hit_count += 1",
                        "lang": "painless",
                    }
                },
            )
        except Exception:
            pass


def _dict_to_summary_response(data: Dict[str, Any]) -> Optional[SummaryResponse]:
    if not data:
        return None
    try:
        stats_data = data.get("stats") or {}
        summary_data = data.get("summary") or {}
        docs_data = data.get("documents") or []

        return SummaryResponse(
            query=data.get("query", ""),
            stats=SummaryStats(**stats_data),
            summary=StructuredSummary(**summary_data),
            documents=[SummaryDocument(**d) for d in docs_data],
        )
    except Exception as err:
        logger.warning("summary_cache_deserialize_failed", error=str(err))
        return None


def build_summary_cache(
    client: OpenSearch,
    embedding_function: OpenAIEmbeddings,
) -> Optional[SummaryResponseCache]:
    if not SUMMARY_CACHE_ENABLED:
        logger.info("summary_cache_disabled")
        return None
    cache = SummaryResponseCache(client=client, embedding_function=embedding_function)
    logger.info(
        "summary_cache_initialized",
        index=cache.index,
        threshold=cache.threshold,
        max_age_days=cache.max_age_days,
    )
    return cache
