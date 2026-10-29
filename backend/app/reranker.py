"""
Cross-encoder reranker.

Wraps two providers behind one interface:
  - Cohere Rerank (API)
  - BGE (HF Inference / TEI / vLLM)

Reranker takes the top-K retrieved docs (typically 50) and re-scores them
with a cross-encoder that takes query and document together — much more
accurate than dot-product similarity but too slow for the full corpus.
Retrieval narrows down; rerank refines.

Selected via `RERANK_PROVIDER` env. When "none", build_reranker() returns
None and the graph's rerank node passes through unchanged.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List, Optional

import structlog
from langchain_core.documents import Document

from app.config import (
    BGE_API_KEY,
    BGE_API_URL,
    BGE_RERANK_MODEL,
    COHERE_API_KEY,
    COHERE_RERANK_MODEL,
    RERANK_PROVIDER,
    RERANK_TOP_N,
)

logger = structlog.get_logger(__name__)


class Reranker(ABC):
    @abstractmethod
    def rerank(self, query: str, docs: List[Document], top_n: int) -> List[Document]:
        """Return the top_n docs, reranked."""


class CohereReranker(Reranker):
    """Cohere Rerank v3.5 — fast, high quality, multilingual."""

    def __init__(self, api_key: str, model: str = "rerank-v3.5"):
        import cohere
        self.client = cohere.ClientV2(api_key=api_key)
        self.model = model
        logger.info("reranker_initialized", provider="cohere", model=model)

    def rerank(self, query: str, docs: List[Document], top_n: int) -> List[Document]:
        if not docs:
            return []

        texts = [d.page_content or "" for d in docs]
        try:
            response = self.client.rerank(
                model=self.model,
                query=query,
                documents=texts,
                top_n=min(top_n, len(docs)),
            )
        except Exception as err:
            logger.warning(
                "cohere_rerank_failed_using_retrieval_order",
                error=str(err),
            )
            return docs[:top_n]

        reranked: List[Document] = []
        for item in response.results:
            idx = item.index
            doc = docs[idx]
            new_meta = dict(doc.metadata)
            new_meta["rerank_score"] = float(item.relevance_score)
            new_meta["original_rank"] = idx
            reranked.append(Document(page_content=doc.page_content, metadata=new_meta))
        return reranked


class BGEReranker(Reranker):
    """
    BAAI BGE cross-encoder via HTTP.

    Expects a TEI-style /rerank endpoint:
      POST /rerank  {"query": "...", "texts": [...]}  →  [{"index": N, "score": F}, ...]
    """

    def __init__(self, api_url: str, api_key: Optional[str], model: str):
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        import requests
        self._requests = requests
        logger.info(
            "reranker_initialized",
            provider="bge",
            model=model,
            api_url=self.api_url,
        )

    def rerank(self, query: str, docs: List[Document], top_n: int) -> List[Document]:
        if not docs:
            return []

        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        texts = [d.page_content or "" for d in docs]
        body = {"query": query, "texts": texts, "model": self.model}

        try:
            response = self._requests.post(
                f"{self.api_url}/rerank",
                json=body,
                headers=headers,
                timeout=10,
            )
            response.raise_for_status()
            results = response.json()
        except Exception as err:
            logger.warning(
                "bge_rerank_failed_using_retrieval_order",
                error=str(err),
            )
            return docs[:top_n]

        if not isinstance(results, list):
            logger.warning("bge_rerank_unexpected_response_shape")
            return docs[:top_n]

        reranked: List[Document] = []
        for item in results[:top_n]:
            idx = int(item.get("index", -1))
            if idx < 0 or idx >= len(docs):
                continue
            doc = docs[idx]
            new_meta = dict(doc.metadata)
            new_meta["rerank_score"] = float(item.get("score", 0.0))
            new_meta["original_rank"] = idx
            reranked.append(Document(page_content=doc.page_content, metadata=new_meta))
        return reranked


def build_reranker() -> Optional[Reranker]:
    """Return a configured reranker, or None if reranking is disabled."""
    if RERANK_PROVIDER == "none":
        return None

    if RERANK_PROVIDER == "cohere":
        if not COHERE_API_KEY:
            raise ValueError("RERANK_PROVIDER=cohere requires COHERE_API_KEY")
        return CohereReranker(api_key=COHERE_API_KEY, model=COHERE_RERANK_MODEL)

    if RERANK_PROVIDER == "bge":
        if not BGE_API_URL:
            raise ValueError(
                "RERANK_PROVIDER=bge requires BGE_API_URL "
                "(an HF Inference / TEI / vLLM endpoint)"
            )
        return BGEReranker(
            api_url=BGE_API_URL,
            api_key=BGE_API_KEY,
            model=BGE_RERANK_MODEL,
        )

    raise ValueError(
        f"Unknown RERANK_PROVIDER='{RERANK_PROVIDER}'. Use 'cohere', 'bge', or 'none'."
    )


DEFAULT_RERANK_TOP_N = RERANK_TOP_N