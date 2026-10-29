#!/usr/bin/env bash
# Create the chunk retrieval indexes and the current alias.

set -euo pipefail

: "${OPENSEARCH_URL:?Set OPENSEARCH_URL}"
: "${OPENSEARCH_USER:?Set OPENSEARCH_USER}"
: "${OPENSEARCH_PASS:?Set OPENSEARCH_PASS}"

CHUNKS_INDEX="${CHUNKS_INDEX:-chunks_v1}"
STATE_INDEX="${CHUNKS_STATE_INDEX:-chunks_state}"
CHUNKS_ALIAS="${CHUNKS_ALIAS:-chunks_current}"
EMBED_DIM="${EMBEDDING_DIMENSION:-1024}"

AUTH=(-u "${OPENSEARCH_USER}:${OPENSEARCH_PASS}")
OPTS=(-sS -H 'Content-Type: application/json')

create_chunks_index() {
  echo "Creating ${CHUNKS_INDEX}..."
  HTTP_CODE=$(curl "${OPTS[@]}" "${AUTH[@]}" -w "%{http_code}" -o /tmp/setup-opensearch-chunks.out \
    -X PUT "${OPENSEARCH_URL}/${CHUNKS_INDEX}" \
    -d "{
      \"settings\": {
        \"index\": {
          \"knn\": true,
          \"knn.algo_param.ef_search\": 100,
          \"number_of_shards\": 2,
          \"number_of_replicas\": 1
        }
      },
      \"mappings\": {
        \"properties\": {
          \"article_id\":       { \"type\": \"keyword\" },
          \"article_title\":    { \"type\": \"text\" },
          \"article_url\":      { \"type\": \"keyword\" },
          \"publication_date\": { \"type\": \"date\" },
          \"topics\":           { \"type\": \"keyword\" },
          \"countries\":        { \"type\": \"keyword\" },
          \"site_name\":        { \"type\": \"keyword\" },
          \"section_heading\":  { \"type\": \"text\" },
          \"body\":             { \"type\": \"text\" },
          \"summary\":          { \"type\": \"text\" },
          \"questions\":        { \"type\": \"text\" },
          \"chunk_index\":      { \"type\": \"integer\" },
          \"chunk_total\":      { \"type\": \"integer\" },
          \"langcode\":         { \"type\": \"keyword\" },
          \"story_type\":       { \"type\": \"keyword\" },
          \"has_summary\":      { \"type\": \"boolean\" },
          \"has_questions\":    { \"type\": \"boolean\" },
          \"low_content\":      { \"type\": \"boolean\" },
          \"token_count\":      { \"type\": \"integer\" },
          \"embed_version\":    { \"type\": \"keyword\" },
          \"document_id\":      { \"type\": \"keyword\" },
          \"embedding\": {
            \"type\": \"knn_vector\",
            \"dimension\": ${EMBED_DIM},
            \"method\": {
              \"engine\": \"lucene\",
              \"name\": \"hnsw\",
              \"space_type\": \"cosinesimil\",
              \"parameters\": { \"ef_construction\": 128, \"m\": 24 }
            }
          },
          \"summary_embedding\": {
            \"type\": \"knn_vector\",
            \"dimension\": ${EMBED_DIM},
            \"method\": {
              \"engine\": \"lucene\",
              \"name\": \"hnsw\",
              \"space_type\": \"cosinesimil\",
              \"parameters\": { \"ef_construction\": 128, \"m\": 24 }
            }
          },
          \"questions_embedding\": {
            \"type\": \"knn_vector\",
            \"dimension\": ${EMBED_DIM},
            \"method\": {
              \"engine\": \"lucene\",
              \"name\": \"hnsw\",
              \"space_type\": \"cosinesimil\",
              \"parameters\": { \"ef_construction\": 128, \"m\": 24 }
            }
          }
        }
      }
    }")

  if [[ "$HTTP_CODE" == "200" ]]; then
    echo "Created ${CHUNKS_INDEX}."
  elif grep -q "resource_already_exists_exception" /tmp/setup-opensearch-chunks.out; then
    echo "${CHUNKS_INDEX} already exists."
  else
    echo "Failed to create ${CHUNKS_INDEX}. HTTP ${HTTP_CODE}"
    cat /tmp/setup-opensearch-chunks.out
    exit 1
  fi
}

create_state_index() {
  echo "Creating ${STATE_INDEX}..."
  HTTP_CODE=$(curl "${OPTS[@]}" "${AUTH[@]}" -w "%{http_code}" -o /tmp/setup-opensearch-state.out \
    -X PUT "${OPENSEARCH_URL}/${STATE_INDEX}" \
    -d "{
      \"mappings\": {
        \"properties\": {
          \"article_id\":          { \"type\": \"keyword\" },
          \"status\":              { \"type\": \"keyword\" },
          \"embed_version\":       { \"type\": \"keyword\" },
          \"chunk_count\":         { \"type\": \"integer\" },
          \"summaries_generated\": { \"type\": \"integer\" },
          \"questions_generated\": { \"type\": \"integer\" },
          \"last_attempt\":        { \"type\": \"date\" },
          \"last_embedded_at\":    { \"type\": \"date\" },
          \"error\":               { \"type\": \"text\" }
        }
      }
    }")

  if [[ "$HTTP_CODE" == "200" ]]; then
    echo "Created ${STATE_INDEX}."
  elif grep -q "resource_already_exists_exception" /tmp/setup-opensearch-state.out; then
    echo "${STATE_INDEX} already exists."
  else
    echo "Failed to create ${STATE_INDEX}. HTTP ${HTTP_CODE}"
    cat /tmp/setup-opensearch-state.out
    exit 1
  fi
}

ensure_alias() {
  echo "Ensuring alias ${CHUNKS_ALIAS} -> ${CHUNKS_INDEX}..."
  curl "${OPTS[@]}" "${AUTH[@]}" -X POST "${OPENSEARCH_URL}/_aliases" \
    -d "{
      \"actions\": [
        { \"add\": { \"index\": \"${CHUNKS_INDEX}\", \"alias\": \"${CHUNKS_ALIAS}\" } }
      ]
    }" >/dev/null
  echo "Alias ready."
}

create_chunks_index
create_state_index
ensure_alias

echo "OpenSearch setup complete."
