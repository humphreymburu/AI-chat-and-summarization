# AI Knowledge Search

AI search and chat over a document knowledge base. Users can search publications, get a
structured summary of a topic, or ask questions in a chat that answers from the indexed
documents and cites its sources.

## How it works

```
 Source articles (OpenSearch: v5)
        │
        ▼
 embeddings/   chunk HTML → LLM summary + questions per chunk → embed (Qwen3, 1024-d)
        │
        ▼
 Chunks index (OpenSearch: chunks_v1)
        │
        ▼
 backend/      hybrid search (BM25 + vector) → rerank → grade → answer (LangGraph)
        │      streams answer + sources over SSE
        ▼
 frontend/     Next.js pages: /chat, /summary
```

**Retrieval pipeline (backend).** Each chat turn runs through a LangGraph graph:
classify intent → condense the question → optionally generate a HyDE query →
hybrid retrieve → rerank → grade relevance (rewrite the query and retry if weak) →
build context → stream the answer. Sources are sent only from the documents that
survive grading, so every source card supports the answer.

**Multi-view embeddings.** Each chunk is indexed as up to three vectors: the raw
text, an LLM summary, and LLM-generated questions. This lets a user's question
match a chunk from several angles.

## Repository layout

| Folder | What it is | Stack |
|---|---|---|
| [`backend/`](backend) | Search and RAG API | Python 3.12, FastAPI, LangGraph, uv |
| [`embeddings/`](embeddings) | Scheduled indexing worker | Node 20, TypeScript |
| [`frontend/`](frontend) | Web app | Next.js 13, React 18, Tailwind, AI SDK |

Each folder has its own README with more detail.

## Getting started

**Prerequisites:** an OpenSearch cluster with the articles index, an
[OpenRouter](https://openrouter.ai) API key, Python 3.12 + [uv](https://docs.astral.sh/uv/),
and Node.js 20.

### 1. Index the content

```bash
cd embeddings
npm install
cp .env.example .env              # OpenSearch + OpenRouter settings
bash scripts/setup-opensearch.sh  # create the chunks index
npm run dev                       # polls for new articles and indexes them
```

### 2. Start the API

```bash
cd backend
uv sync
# create .env with OPENSEARCH_* and OPENROUTER_* settings (see Configuration)
uv run uvicorn app.main:app --reload --port 8000
```

Check it is up: `curl localhost:8000/health`

### 3. Start the web app

```bash
cd frontend
npm install
cp .env.example .env              # NEXT_PUBLIC_UNEP_AI_CHAT_URL points at the API
npm run dev
```

Open http://localhost:3000/chat.

## Configuration

Settings come from each service's `.env` file. `.env` files are git-ignored;
`.env.example` files are the templates.

| Variable | Service | Purpose |
|---|---|---|
| `OPENSEARCH_URL`, `OPENSEARCH_USER`, `OPENSEARCH_PASS` | embeddings, backend | OpenSearch connection |
| `OPENROUTER_API_KEY` | embeddings, backend | LLM and embedding calls |
| `OPENROUTER_EMBEDDING_MODEL`, `EMBEDDING_DIMENSION` | embeddings, backend | Must match on both sides, or retrieval scores are meaningless |
| `RERANK_PROVIDER` | backend | `none`, `cohere` or `bge` |
| `CHECKPOINT_PROVIDER` | backend | Where chat threads are stored (`none`, `memory`, `sqlite` or `redis`) |
| `WEB_SEARCH_PROVIDER` | backend | Web search tool provider (Tavily, Brave or SerpAPI) |
| `NEXT_PUBLIC_UNEP_AI_CHAT_URL` | frontend | Chat endpoint, e.g. `http://127.0.0.1:8000/chat/ui` |

## API

| Endpoint | Description |
|---|---|
| `POST /chat/ui` | Chat stream in the AI SDK UI message format (used by the frontend) |
| `POST /chat/stream` | Chat as server-sent events: tokens, sources, status |
| `POST /search` | Hybrid search, no generation |
| `GET /thread/{thread_id}` | Conversation history |
| `GET /health` | Service status and enabled features (reranker, tools, cache) |
| `GET /metrics` | Latency and usage metrics |

## Development

```bash
(cd backend    && uv run python -m pytest)
(cd embeddings && npm test)
(cd frontend   && npm test)
```
