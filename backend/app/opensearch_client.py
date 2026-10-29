"""OpenSearch client builder. Centralizes timeout, retry, TLS config."""

from __future__ import annotations

import os

from opensearchpy import OpenSearch

from app.config import OPENSEARCH_PASSWORD, OPENSEARCH_URL, OPENSEARCH_USERNAME


def build_opensearch_client() -> OpenSearch:
    if not OPENSEARCH_URL:
        raise ValueError("OPENSEARCH_URL (V2_OPENSEARCH_SERVICE_URL) is required")
    if not OPENSEARCH_PASSWORD:
        raise ValueError("OPENSEARCH_PASSWORD (V2_OPENSEARCH_PASSWORD) is required")

    return OpenSearch(
        hosts=[OPENSEARCH_URL],
        http_auth=(OPENSEARCH_USERNAME, OPENSEARCH_PASSWORD),
        verify_certs=os.getenv("OPENSEARCH_VERIFY_CERTS", "false").lower() == "true",
        timeout=int(os.getenv("OPENSEARCH_TIMEOUT_S", "10")),
        max_retries=int(os.getenv("OPENSEARCH_MAX_RETRIES", "2")),
        retry_on_timeout=True,
    )