#!/usr/bin/env bash
# Quick diagnostic queries against OpenSearch.
#
# Usage:
#   export OPENSEARCH_URL=https://search-staging.unenvironment.xyz
#   export OPENSEARCH_USER=admin
#   export OPENSEARCH_PASS=********
#   bash scripts/inspect-open-search.sh                  # run all checks
#   bash scripts/inspect-open-search.sh chunks_v1        # inspect a specific index

set -euo pipefail

OPENSEARCH_USER="${OPENSEARCH_USER:-${OPENSEARCH_USERNAME:-}}"
OPENSEARCH_PASS="${OPENSEARCH_PASS:-${OPENSEARCH_PASSWORD:-}}"

: "${OPENSEARCH_URL:?Set OPENSEARCH_URL}"
: "${OPENSEARCH_USER:?Set OPENSEARCH_USER or OPENSEARCH_USERNAME}"
: "${OPENSEARCH_PASS:?Set OPENSEARCH_PASS or OPENSEARCH_PASSWORD}"

OPENSEARCH_URL="${OPENSEARCH_URL%/}"

AUTH=(-u "${OPENSEARCH_USER}:${OPENSEARCH_PASS}")
OPTS=(-sS -H 'Content-Type: application/json')

CHUNKS_INDEX="${CHUNKS_INDEX:-chunks_v1}"
STATE_INDEX="${STATE_INDEX:-chunks_state}"
SUMMARY_CACHE_INDEX="${SUMMARY_CACHE_INDEX:-summary_cache_v1}"
PIPELINE="${HYBRID_PIPELINE:-hybrid-pipeline}"

hr() { echo ""; echo "==================== $* ===================="; }

inspect_index() {
  local idx="$1"
  hr "Index: ${idx}"

  echo "→ count"
  curl "${OPTS[@]}" "${AUTH[@]}" "${OPENSEARCH_URL}/${idx}/_count?pretty" || true

  echo "→ mapping (top-level field names)"
  curl "${OPTS[@]}" "${AUTH[@]}" "${OPENSEARCH_URL}/${idx}/_mapping" 2>/dev/null \
    | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for index_name, body in data.items():
        props = body.get('mappings', {}).get('properties', {})
        for k, v in props.items():
            t = v.get('type', 'object')
            extra = ''
            if t == 'knn_vector':
                extra = f\" (dim={v.get('dimension')})\"
            print(f'  - {k}: {t}{extra}')
except Exception as e:
    print(f'  (could not parse: {e})')
" || true

  echo "→ first document sample"
  curl "${OPTS[@]}" "${AUTH[@]}" \
    "${OPENSEARCH_URL}/${idx}/_search?pretty&size=1" \
    -d '{"_source": {"excludes": ["*embedding*"]}}' 2>/dev/null \
    | head -60 || true
}

if [[ $# -gt 0 ]]; then
  inspect_index "$1"
  exit 0
fi

hr "Cluster health"
curl "${OPTS[@]}" "${AUTH[@]}" "${OPENSEARCH_URL}/_cluster/health?pretty"

hr "All indexes"
curl "${OPTS[@]}" "${AUTH[@]}" "${OPENSEARCH_URL}/_cat/indices?v"

hr "Aliases"
curl "${OPTS[@]}" "${AUTH[@]}" "${OPENSEARCH_URL}/_cat/aliases?v"

hr "Search pipeline: ${PIPELINE}"
curl "${OPTS[@]}" "${AUTH[@]}" \
  "${OPENSEARCH_URL}/_search/pipeline/${PIPELINE}?pretty" || true

inspect_index "${CHUNKS_INDEX}"
inspect_index "${STATE_INDEX}"
inspect_index "${SUMMARY_CACHE_INDEX}"
