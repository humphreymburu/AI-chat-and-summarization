# UNEP Search — Embeddings Service

A scheduled indexing worker that transforms UNEP articles into a searchable vector knowledge base for the RAG pipeline.

## What it does

The service polls an OpenSearch articles index on a configurable interval (default every 2 minutes), processes each article through a multi-stage pipeline, and writes enriched vector chunks back to OpenSearch for retrieval.

```
Articles Index (OpenSearch)
        │
        ▼
   Fetch articles
        │
        ▼
  HTML chunking           ← structure-aware, token-bounded splits
        │
        ▼
  View generation         ← LLM generates: body | summary | questions per chunk
        │
        ▼
  Embed & index           ← writes to chunks_v1 with multi-vector per chunk
        │
        ▼
Chunks Index (OpenSearch)
```

## Tech stack

- **Runtime**: Node.js 20, TypeScript
- **Vector store**: OpenSearch (`chunks_v1` index)
- **LLM**: Azure OpenAI (summary & question generation)
- **Embeddings**: Qwen3-8B (1024-dim vectors)
- **Tokenizer**: `js-tiktoken` (cl100k_base)
- **HTML parsing**: Cheerio
- **Scheduler**: node-schedule
- **Logging**: Pino (structured JSON)

## Multi-view embeddings

Each chunk is stored with up to three text views, each embedded separately:

| View | Condition | Purpose |
|---|---|---|
| `body` | Always | Raw chunk text with title/heading context |
| `summary` | ≥ 200 tokens | LLM-generated institutional summary |
| `questions` | ≥ 150 tokens | LLM-generated Q&A pairs |

This gives the retriever multiple angles to match a query against.

## Getting started

### Prerequisites

- Node.js 20+
- An accessible OpenSearch cluster
- Azure OpenAI credentials (for view generation)

### Install

```bash
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

Key variables:

| Variable | Default | Description |
|---|---|---|
| `OPENSEARCH_URL` | — | OpenSearch cluster URL (required) |
| `OPENSEARCH_USER` | — | Auth username (required) |
| `OPENSEARCH_PASS` | — | Auth password (required) |
| `ARTICLES_INDEX` | `v5` | Source articles index name |
| `CHUNKS_INDEX` | `chunks_v1` | Output chunks index name |
| `SCHEDULER_INTERVAL_MS` | `120000` | Poll interval in ms |
| `BATCH_SIZE` | `10` | Articles processed per cycle |
| `EMBEDDING_DIMENSION` | `1024` | Must match the embedding model |
| `SOURCE_LANGCODE` | `en` | Language filter |

### Set up OpenSearch indexes

```bash
bash scripts/setup-opensearch.sh
```

### Run

```bash
# Development (hot-reload)
npm run dev

# Production
npm run build
npm run start
```

## Utility scripts

```bash
# Backfill pending articles (optional: pass a limit)
npm run backfill -- 50

# Reprocess a single article by ID (for debugging)
npm run reprocess -- <article-id>

# Run chunker unit tests
npm run chunker:test

# Full test suite
npm run test
```

## Health & observability

The service exposes a health server on port `8081` (configurable via `HEALTH_PORT`):

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness probe — returns `200 OK` or `503` if degraded |
| `GET /metrics` | Processing metrics: articles processed, chunks created, consecutive failures |

Logs are emitted as structured JSON (Pino) with the service name `embedding-service`.

## Deployment

The service is containerised. Build and run with Docker:

```bash
docker build -t unep-embeddings .
docker run --env-file .env -p 8081:8081 unep-embeddings
```

The container runs as a non-root `app` user and handles `SIGTERM`/`SIGINT` for graceful shutdown.

## Project structure

```
src/
├── scheduler.ts          # Main polling loop + health server
├── embeddingPipeline.ts  # Fetch → chunk → embed → index orchestration
├── chunker.ts            # HTML parsing and token-bounded splitting
├── prompts.ts            # Summary/question prompt templates
├── config.ts             # Environment variable schema
├── health.ts             # Health check server and state
├── logger.ts             # Pino logger setup
├── backfill.ts           # Batch reprocessing utility
├── reprocess.ts          # Single-article debug utility
└── chunker.test.ts       # Chunker unit tests

scripts/
├── setup-opensearch.sh         # Create chunks_v1 and chunks_state indexes
├── setup-summary-cache.sh      # Create semantic response cache index
└── inspect-open-search.sh      # Debug utilities
```

## Versioning

The `EMBED_VERSION` environment variable is stamped on every chunk and state record. Bump it whenever chunking logic or embedding models change — the pipeline uses this to detect and re-embed stale chunks safely.
