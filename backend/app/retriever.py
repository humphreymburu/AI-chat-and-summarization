"""
OpenSearchHybridRetriever.

4-branch hybrid retrieval:
  - lexical (BM25 on `body`)
  - main embedding (full chunk text)
  - summary embedding (LLM-generated one-sentence summary)
  - questions embedding (LLM-generated questions chunk answers)

Scores are fused by the search pipeline (server-side, default name:
hybrid-pipeline). The retriever doesn't know about HyDE — the graph passes
either the original or HyDE-rewritten text via `vector_query_text`.

Two entry points:
  search(query, ...)              — embeds query as-is (back-compat)
  search_with_text(lex, vec, ...) — accepts pre-resolved vector query
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

import structlog
from langchain_core.documents import Document
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from opensearchpy import OpenSearch

from app.config import (
    HYBRID_RAG_K,
    HYBRID_TOP_K,
    HYBRID_VECTOR_K,
    METRICS_BRANCH_PROBE,
    OPENSEARCH_HYBRID_PIPELINE,
    OPENSEARCH_INDEX_NAME,
)
from app.hyde import generate_hyde, should_use_hyde
from app.metrics import RetrieverMetrics

logger = structlog.get_logger(__name__)


class OpenSearchHybridRetriever:
    def __init__(
        self,
        client: OpenSearch,
        embedding_function: OpenAIEmbeddings,
        metrics: Optional[RetrieverMetrics] = None,
    ) -> None:
        self.client = client
        self.embedding_function = embedding_function
        self.metrics = metrics or RetrieverMetrics()

    # -- public API ----------------------------------------------------------

    def search(
        self,
        query: str,
        mode: str = "search",
        filters: Optional[Dict[str, Any]] = None,
        llm: Optional[ChatOpenAI] = None,
    ) -> List[Document]:
        """
        Convenience entry point: embed query as-is, optionally apply HyDE
        if an LLM is supplied and the query qualifies.
        """
        vector_query_text = query
        hyde_applied = False

        if llm and should_use_hyde(query):
            hyde_text = generate_hyde(llm, query)
            if hyde_text:
                # Guard: generate_hyde returns Optional[str]; only use the
                # rewrite if it succeeded. Otherwise fall back to original.
                vector_query_text = hyde_text
                hyde_applied = True
                logger.info("hyde_applied", query=query, hyde_preview=hyde_text[:200])
            else:
                logger.warning("hyde_failed_using_original", query=query)

        return self.search_with_text(
            lexical_query=query,
            vector_query_text=vector_query_text,
            mode=mode,
            filters=filters,
            hyde_applied=hyde_applied,
        )

    def search_with_text(
        self,
        lexical_query: str,
        vector_query_text: str,
        mode: str = "search",
        filters: Optional[Dict[str, Any]] = None,
        hyde_applied: bool = False,
    ) -> List[Document]:
        """
        Hybrid retrieval with separately-resolved lexical and vector queries.

        Lexical branch uses the user's original text. Vector branches use the
        embedding of `vector_query_text` (original or HyDE rewrite).
        """
        started = time.perf_counter()
        branch_filters = self._build_filters(filters)

        # Same vector across all 3 knn branches. When HyDE is applied, all
        # three branches search using the hypothetical-answer embedding —
        # intentional, since HyDE bridges vocabulary gaps that affect all
        # vector-based views equally.
        query_vector = self.embedding_function.embed_query(vector_query_text)

        body = self._build_hybrid_body(
            lexical_query=lexical_query,
            query_vector=query_vector,
            branch_filters=branch_filters,
            mode=mode,
        )

        try:
            resp = self.client.search(
                index=OPENSEARCH_INDEX_NAME,
                body=body,
                params={"search_pipeline": OPENSEARCH_HYBRID_PIPELINE},
            )
        except Exception as err:
            logger.exception(
                "opensearch_search_failed",
                index=OPENSEARCH_INDEX_NAME,
                pipeline=OPENSEARCH_HYBRID_PIPELINE,
                error_type=type(err).__name__,
            )
            raise

        docs = self._hits_to_documents(resp, mode)

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        self.metrics.record_query(elapsed_ms=elapsed_ms, hyde_applied=hyde_applied)

        if not docs:
            logger.warning(
                "no_documents_retrieved",
                lexical_query=lexical_query,
                vector_query_preview=vector_query_text[:120],
                filters=filters,
                hyde_applied=hyde_applied,
            )

        logger.info(
            "retrieval_results",
            mode=mode,
            count=len(docs),
            hyde_applied=hyde_applied,
            opensearch_elapsed_ms=elapsed_ms,
            results=[
                {
                    "rank": i + 1,
                    "article_id": d.metadata.get("article_id"),
                    "article_title": d.metadata.get("article_title"),
                    "section_heading": d.metadata.get("section_heading"),
                    "hybrid_score": d.metadata.get("hybrid_score"),
                    "url": d.metadata.get("article_url"),
                }
                for i, d in enumerate(docs)
            ],
        )

        if METRICS_BRANCH_PROBE:
            try:
                self._probe_branch_scores(lexical_query, query_vector, branch_filters)
            except Exception as probe_error:
                logger.warning("branch_probe_failed", error=str(probe_error))

        self.metrics.log_snapshot()
        return docs

    # -- private -------------------------------------------------------------

    def _build_filters(
        self, filters: Optional[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Return an empty list when no filters supplied. The caller decides
        defaults (e.g., the graph applies langcode=en if no filters present).
        """
        if not filters:
            return []

        out: List[Dict[str, Any]] = []
        langcode = filters.get("langcode")
        if isinstance(langcode, str) and langcode:
            out.append({"term": {"langcode": langcode}})
        topics = filters.get("topics")
        if isinstance(topics, list) and topics:
            out.append({"terms": {"topics": topics}})
        site_name = filters.get("site_name")
        if isinstance(site_name, str) and site_name:
            out.append({"term": {"site_name": site_name}})
        story_type = filters.get("story_type")
        if isinstance(story_type, list) and story_type:
            out.append({"terms": {"story_type": story_type}})
        content_types = filters.get("content_types")
        if isinstance(content_types, list) and content_types:
            # .keyword: content_type was dynamic-mapped as text (its analyzer
            # splits "press_release" into separate tokens), so an exact-match
            # terms query has to hit the raw keyword subfield instead.
            out.append({"terms": {"content_type.keyword": content_types}})
        resource_types = filters.get("resource_types")
        if isinstance(resource_types, list) and resource_types:
            out.append({"terms": {"resource_type.keyword": resource_types}})
        date_gte = filters.get("publication_date_gte")
        if isinstance(date_gte, str) and date_gte:
            out.append({"range": {"publication_date": {"gte": date_gte}}})
        return out

    def _build_hybrid_body(
        self,
        lexical_query: str,
        query_vector: List[float],
        branch_filters: List[Dict[str, Any]],
        mode: str,
    ) -> Dict[str, Any]:
        knn_clause = lambda field: {
            "bool": {
                "must": [{"knn": {field: {"vector": query_vector, "k": HYBRID_VECTOR_K}}}],
                "filter": branch_filters,
            }
        }

        hybrid_queries = [
            {"bool": {
                "must": [{"match": {"body": {"query": lexical_query}}}],
                "filter": branch_filters,
            }},
            knn_clause("embedding"),
            knn_clause("summary_embedding"),
            knn_clause("questions_embedding"),
        ]

        # Pick size by mode. RAG mode is for the LLM context; smaller. Search
        # mode is for UI display with article-level collapse; larger.
        size = HYBRID_RAG_K if mode == "rag" else HYBRID_TOP_K

        body: Dict[str, Any] = {
            "size": size,
            "query": {"hybrid": {"queries": hybrid_queries}},
            "_source": [
                "article_id", "article_title", "article_url",
                "publication_date", "topics", "site_name",
                "section_heading", "body", "summary", "questions",
                "chunk_index", "chunk_total", "langcode", "story_type",
                "has_summary", "has_questions",
            ],
        }

        if mode != "rag":
            body["collapse"] = {
                "field": "article_id",
                "inner_hits": {
                    "name": "best_chunk",
                    "size": 1,
                    "_source": [
                        "section_heading", "body", "summary", "questions",
                        "chunk_index", "chunk_total",
                        "has_summary", "has_questions",
                    ],
                },
            }
        return body

    def _hits_to_documents(
        self, response: Dict[str, Any], mode: str
    ) -> List[Document]:
        docs: List[Document] = []
        for hit in response.get("hits", {}).get("hits", []):
            source = hit.get("_source", {}) or {}
            content = source.get("body") or ""
            metadata: Dict[str, Any] = {
                "opensearch_id": hit.get("_id"),
                "hybrid_score": hit.get("_score"),
                "article_id": source.get("article_id"),
                "article_title": source.get("article_title"),
                "article_url": source.get("article_url"),
                "publication_date": source.get("publication_date"),
                "topics": source.get("topics"),
                "site_name": source.get("site_name"),
                "section_heading": source.get("section_heading"),
                "summary": source.get("summary"),
                "questions": source.get("questions"),
                "langcode": source.get("langcode"),
                "story_type": source.get("story_type"),
                "has_summary": source.get("has_summary"),
                "has_questions": source.get("has_questions"),
            }
            if mode != "rag":
                inner = (
                    (hit.get("inner_hits") or {})
                    .get("best_chunk", {})
                    .get("hits", {})
                    .get("hits", [])
                )
                if inner:
                    best = inner[0].get("_source", {}) or {}
                    metadata["best_chunk"] = best
                    content = best.get("body") or content
            docs.append(Document(page_content=content, metadata=metadata))
        return docs

    def _probe_branch_scores(
        self,
        lexical_query: str,
        query_vector: List[float],
        branch_filters: List[Dict[str, Any]],
    ) -> None:
        """
        Raw per-branch top-1 scores. NOT pipeline-normalized; not comparable
        across branches (BM25 lives in [0, 30+]; cosine in [0, 1]). Useful
        for "is this branch hitting anything?" debugging, not for measuring
        branch contribution to final ranking.
        """
        probes = {
            "lexical": {"bool": {
                "must": [{"match": {"body": {"query": lexical_query}}}],
                "filter": branch_filters,
            }},
        }
        for field in ("embedding", "summary_embedding", "questions_embedding"):
            probes[field] = {"bool": {
                "must": [{"knn": {field: {
                    "vector": query_vector, "k": HYBRID_VECTOR_K,
                }}}],
                "filter": branch_filters,
            }}

        for name, clause in probes.items():
            response = self.client.search(
                index=OPENSEARCH_INDEX_NAME,
                body={"size": 1, "query": clause},
            )
            hits = response.get("hits", {}).get("hits", []) or []
            score = float(hits[0].get("_score") or 0.0) if hits else 0.0
            self.metrics.record_branch_score(name, score)
