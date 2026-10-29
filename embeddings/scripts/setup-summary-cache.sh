#!/usr/bin/env bash
# Create the summary_cache_v1 index for semantic response caching.
#
# Usage:
#   export OPENSEARCH_URL=https://search-staging.unenvironment.xyz
#   export OPENSEARCH_USER=admin
#   export OPENSEARCH_PASS=********
#   bash setup-summary-cache.sh
#
# Schema:
#   query             — original query text (for debugging only)
#   query_embedding   — 1024-dim Qwen3 vector (must match corpus dimension)
#   summary_response  — full SummaryResponse JSON (object, NOT indexed; faster)
#   filters_hash      — 16-char SHA-256 of normalized request filters
#   created_at        — ISO timestamp for TTL/recency filtering
#   hit_count         — popularity counter (incremented async on each hit)

set -euo pipefail

: "${OPENSEARCH_URL:?Set OPENSEARCH_URL}"
: "${OPENSEARCH_USER:?Set OPENSEARCH_USER}"
: "${OPENSEARCH_PASS:?Set OPENSEARCH_PASS}"

INDEX="${SUMMARY_CACHE_INDEX:-summary_cache_v1}"
EMBED_DIM="${EMBEDDING_DIMENSION:-1024}"

AUTH=(-u "${OPENSEARCH_USER}:${OPENSEARCH_PASS}")
OPTS=(-sS -H 'Content-Type: application/json')

echo "Creating index ${INDEX} (embedding dimension ${EMBED_DIM})..."

HTTP_CODE=$(curl "${OPTS[@]}" "${AUTH[@]}" -w "%{http_code}" -o /tmp/setup-summary-cache.out \
  -X PUT "${OPENSEARCH_URL}/${INDEX}" \
  -d "{
    \"settings\": {
      \"index\": {
        \"knn\": true,
        \"knn.algo_param.ef_search\": 100,
        \"number_of_shards\": 1,
        \"number_of_replicas\": 1
      }
    },
    \"mappings\": {
      \"properties\": {
        \"query\":             { \"type\": \"text\" },
        \"query_embedding\": {
          \"type\": \"knn_vector\",
          \"dimension\": ${EMBED_DIM},
          \"method\": {
            \"engine\": \"lucene\",
            \"name\": \"hnsw\",
            \"space_type\": \"cosinesimil\",
            \"parameters\": { \"ef_construction\": 128, \"m\": 24 }
          }
        },
        \"summary_response\": { \"type\": \"object\", \"enabled\": false },
        \"filters_hash\":     { \"type\": \"keyword\" },
        \"created_at\":       { \"type\": \"date\" },
        \"hit_count\":        { \"type\": \"long\" }
      }
    }
  }")

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "✓ Index ${INDEX} created."
elif grep -q "resource_already_exists_exception" /tmp/setup-summary-cache.out; then
  echo "✓ Index ${INDEX} already exists (no-op)."
else
  echo "✗ Failed to create ${INDEX}. HTTP ${HTTP_CODE}"
  cat /tmp/setup-summary-cache.out
  exit 1
fi

echo ""
echo "Verifying mapping..."
curl "${OPTS[@]}" "${AUTH[@]}" "${OPENSEARCH_URL}/${INDEX}/_mapping?pretty"

echo ""
echo "Done. Set SUMMARY_CACHE_ENABLED=true to activate the cache."