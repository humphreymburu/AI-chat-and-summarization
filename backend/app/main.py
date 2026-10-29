"""
FastAPI + LangServe entrypoint.

Endpoints:
  /chat/*                  — LangServe-mounted conversational endpoints
  /chat/events             — SSE intermediate-state stream (gated by env)
  /search                  — Structured summary + ranked documents
  /thread/{thread_id}      — Inspect checkpointed conversation state
  /admin/cache/flush       — Flush the summary cache after re-indexing
  /health, /metrics

Startup wiring (inside FastAPI lifespan):
  1. Build six LLMs (chat / hyde / grading / intent / tool_planner / summary)
  2. Build embedding client + verify dimension
  3. Build OpenSearch client and retriever
  4. Build optional features: reranker, tools, checkpointer, summary cache
  5. Compile the agentic graph
  6. On shutdown: release checkpointer connections
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Dict, Optional

import structlog
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator

from app.checkpointing import build_checkpointer_async
from app.config import (
    ADMIN_TOKEN,
    CHECKPOINT_PROVIDER,
    CORS_ALLOW_ORIGINS,
    DEFAULT_RESOURCES_SCANNED,
    DEFAULT_TOTAL_KNOWLEDGE_HUBS,
    STARTUP_EMBEDDING_CHECK,
    STREAM_INTERMEDIATE_STATE,
)
from app.embeddings import build_embeddings, startup_embedding_assertions
from app.graph import build_rag_graph
from app.llm import (
    build_chat_llm,
    build_grading_llm,
    build_hyde_llm,
    build_intent_llm,
    build_summary_llm,
    build_tool_planner_llm,
)
from app.metrics import RetrieverMetrics
from app.opensearch_client import build_opensearch_client
from app.reranker import build_reranker
from app.retriever import OpenSearchHybridRetriever
from app.summary import (
    StructuredSummary,
    SummaryResponse,
    build_summary_response,
    compute_stats,
)
from app.summary_cache import build_summary_cache
from app.tools import build_tools

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Module-level state — set inside lifespan, read by route handlers
# ---------------------------------------------------------------------------

rag_graph = None
checkpointer = None
_checkpointer_teardown = None
summary_cache = None
metrics: Optional[RetrieverMetrics] = None
reranker = None
tools: Dict[str, Any] = {}


# ---------------------------------------------------------------------------
# Lifespan — startup and graceful shutdown
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    global rag_graph, checkpointer, _checkpointer_teardown
    global summary_cache, metrics, reranker, tools

    logger.info("startup_begin")

    # Six LLMs
    chat_llm = build_chat_llm()
    hyde_llm = build_hyde_llm()
    grading_llm = build_grading_llm()
    intent_llm = build_intent_llm()
    tool_planner_llm = build_tool_planner_llm()
    summary_llm = build_summary_llm(chat_llm)

    # Embeddings
    embedding_fn = build_embeddings()
    if STARTUP_EMBEDDING_CHECK:
        startup_embedding_assertions(embedding_fn)
    else:
        logger.warning("startup_embedding_check_skipped")

    # OpenSearch and retriever
    os_client = build_opensearch_client()
    metrics = RetrieverMetrics()
    retriever = OpenSearchHybridRetriever(
        client=os_client,
        embedding_function=embedding_fn,
        metrics=metrics,
    )

    # Optional features
    reranker = build_reranker()
    tools = build_tools()
    checkpointer, _checkpointer_teardown = await build_checkpointer_async()
    summary_cache = build_summary_cache(client=os_client, embedding_function=embedding_fn)

    # Compile the graph
    rag_graph = build_rag_graph(
        chat_llm=chat_llm,
        hyde_llm=hyde_llm,
        grading_llm=grading_llm,
        intent_llm=intent_llm,
        tool_planner_llm=tool_planner_llm,
        summary_llm=summary_llm,
        retriever=retriever,
        reranker=reranker,
        tools=tools,
        checkpointer=checkpointer,
    )
    logger.info(
        "startup_graph_compiled",
        rerank_enabled=reranker is not None,
        tools_enabled=list(tools.keys()),
        checkpoint_provider=CHECKPOINT_PROVIDER,
        stream_intermediate=STREAM_INTERMEDIATE_STATE,
        summary_cache_enabled=summary_cache is not None,
    )

    yield

    # Shutdown — release checkpointer connections (SQLite file, Redis pool, etc.)
    if _checkpointer_teardown is not None:
        await _checkpointer_teardown()
    logger.info("shutdown_complete")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Scope chips in the UI ("Publications only", "Last 12 months", ...) map to
# retriever filters. content_type / resource_type come from the source
# articles index (v5) via the embeddings worker.
SCOPE_FILTERS: Dict[str, Dict[str, Any]] = {
    "all": {},
    "resource": {"content_types": ["resource", "report_flagship"]},
    "recent": {"publication_date_gte": "now-1y/d"},
    "policy": {
        "resource_types": [
            "Policy and strategy",
            "Medium term strategies",
            "Resolutions, Treaties and Decisions",
        ]
    },
}


def _apply_scope(
    filters: Optional[Dict[str, Any]], scope: Optional[str]
) -> Optional[Dict[str, Any]]:
    """Merge a UI scope into explicit filters (explicit filters win)."""
    scope_filters = SCOPE_FILTERS.get((scope or "all").lower(), {})
    if not scope_filters:
        return filters
    # Any filter disables the graph's langcode=en default, so keep it here.
    return {"langcode": "en", **scope_filters, **(filters or {})}


def _to_initial_state(req: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "question": req.get("question", ""),
        "chat_history": req.get("chat_history") or [],
        "mode": (req.get("mode") or "search").lower(),
        "filters": _apply_scope(req.get("filters"), req.get("scope")),
        "timings": {},
    }


def _graph_config(req: Dict[str, Any]) -> Dict[str, Any]:
    thread_id = req.get("thread_id") or str(uuid.uuid4())
    config: Dict[str, Any] = {"recursion_limit": 50}
    if checkpointer is not None:
        config["configurable"] = {"thread_id": thread_id}
    return config


def _elapsed_ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)


# ---------------------------------------------------------------------------
# /chat adapters
# ---------------------------------------------------------------------------

def _invoke_graph(req: Dict[str, Any]) -> str:
    state = rag_graph.invoke(_to_initial_state(req), config=_graph_config(req))
    return state.get("answer", "")


async def _astream_graph(req: Dict[str, Any]) -> AsyncIterator[str]:
    initial = _to_initial_state(req)
    config = _graph_config(req)
    async for part in rag_graph.astream(
        initial,
        config=config,
        stream_mode="messages",
        version="v2",
    ):
        if part.get("type") != "messages":
            continue
        chunk, metadata = part.get("data") or (None, {})
        if metadata.get("langgraph_node") != "generate_answer":
            continue
        if chunk is None:
            continue
        content = getattr(chunk, "content", "") or ""
        if content:
            yield content


def _doc_to_chat_source(doc: Any) -> Dict[str, str]:
    metadata = getattr(doc, "metadata", {}) or {}
    title = (
        metadata.get("article_title")
        or metadata.get("title")
        or metadata.get("section_heading")
        or "UNEP source"
    )
    url = metadata.get("article_url") or metadata.get("url") or metadata.get("path") or ""
    source = metadata.get("site_name") or metadata.get("source") or ""
    return {
        "title": str(title),
        "url": str(url),
        "source": str(source),
    }


def _docs_to_chat_sources(docs: list, limit: int = 6) -> list[Dict[str, str]]:
    sources: list[Dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for doc in docs:
        source = _doc_to_chat_source(doc)
        key = (source["url"], source["title"])
        if key in seen:
            continue
        seen.add(key)
        sources.append(source)
        if len(sources) >= limit:
            break
    return sources


async def _astream_chat_response(
    req: Dict[str, Any],
    request_id: str,
    started_at: float,
) -> AsyncIterator[Dict[str, Any]]:
    initial = _to_initial_state(req)
    config = _graph_config(req)
    sent_sources = False
    first_token_ms: int | None = None
    token_count = 0
    char_count = 0
    logged_nodes: set[str] = set()
    final_answer = ""
    async for part in rag_graph.astream(
        initial,
        config=config,
        stream_mode=["updates", "messages", "values"],
        version="v2",
    ):
        kind = part.get("type")
        if kind in ("updates", "values"):
            items = (
                (part.get("data") or {}).items()
                if kind == "updates"
                else [("values", part.get("data") or {})]
            )
            for node, output in items:
                if kind == "updates" and node not in logged_nodes:
                    logged_nodes.add(node)
                    timing_snapshot = (output or {}).get("timings") or {}
                    logger.info(
                        "chat_stream_node_update",
                        request_id=request_id,
                        thread_id=req.get("thread_id"),
                        node=node,
                        elapsed_ms=_elapsed_ms(started_at),
                        timings=timing_snapshot,
                        retrieved_docs=len((output or {}).get("retrieved_docs") or []),
                        reranked_docs=len((output or {}).get("reranked_docs") or []),
                        final_docs=len((output or {}).get("final_docs") or []),
                    )
                output = output or {}
                if kind == "values" and output.get("answer"):
                    final_answer = str(output["answer"])
                if sent_sources:
                    continue
                docs = output.get("final_docs") or []
                sources = _docs_to_chat_sources(docs)
                if sources:
                    sent_sources = True
                    logger.info(
                        "chat_stream_sources_ready",
                        request_id=request_id,
                        thread_id=req.get("thread_id"),
                        node=node,
                        elapsed_ms=_elapsed_ms(started_at),
                        source_count=len(sources),
                    )
                    yield {"type": "sources", "sources": sources}
        elif kind == "messages":
            chunk, metadata = part.get("data") or (None, {})
            if metadata.get("langgraph_node") != "generate_answer":
                continue
            content = getattr(chunk, "content", "") if chunk else ""
            if content:
                if first_token_ms is None:
                    first_token_ms = _elapsed_ms(started_at)
                    logger.info(
                        "chat_stream_first_token",
                        request_id=request_id,
                        thread_id=req.get("thread_id"),
                        elapsed_ms=first_token_ms,
                        langgraph_node=metadata.get("langgraph_node"),
                        llm_provider=metadata.get("ls_provider"),
                        llm_model=metadata.get("ls_model_name"),
                    )
                token_count += 1
                char_count += len(content)
                yield {"type": "token", "token": content}
    # Canned replies (greeting, off-topic, clarification) don't come from the
    # streamed answer node, so send the final answer in one piece.
    if token_count == 0 and final_answer:
        token_count = 1
        char_count = len(final_answer)
        yield {"type": "token", "token": final_answer}
    logger.info(
        "chat_stream_graph_done",
        request_id=request_id,
        thread_id=req.get("thread_id"),
        elapsed_ms=_elapsed_ms(started_at),
        first_token_ms=first_token_ms,
        token_chunks=token_count,
        streamed_chars=char_count,
        sources_sent=sent_sources,
    )


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Generative Chat",
    version="2.2",
    description="UNEP RAG AI API (agentic LangGraph backend)",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
    expose_headers=["*"],
)


# ---------------------------------------------------------------------------
# /chat/stream — native SSE chat endpoint (replaces langserve add_routes)
# ---------------------------------------------------------------------------

class ChatStreamRequest(BaseModel):
    question: str
    chat_history: list = Field(default_factory=list)
    mode: str = "search"
    filters: dict | None = None
    scope: str | None = None
    thread_id: str | None = None

    @model_validator(mode="before")
    @classmethod
    def accept_langserve_input_shape(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data

        input_data = data.get("input")
        if not isinstance(input_data, dict):
            return data

        normalized = {**data}
        normalized.pop("input", None)
        for key in ("question", "chat_history", "mode", "filters", "scope", "thread_id"):
            if key not in normalized and key in input_data:
                normalized[key] = input_data[key]
        return normalized


@app.post("/chat/stream")
async def chat_stream(req: ChatStreamRequest):
    """Stream chat tokens as SSE using LangGraph astream (messages mode)."""
    payload = req.model_dump()
    request_id = str(uuid.uuid4())
    started_at = time.perf_counter()
    question = payload.get("question") or ""
    logger.info(
        "chat_stream_request_started",
        request_id=request_id,
        thread_id=payload.get("thread_id"),
        mode=payload.get("mode"),
        question_chars=len(question),
        question_preview=question[:160],
        history_turns=len(payload.get("chat_history") or []),
        has_filters=bool(payload.get("filters")),
    )

    async def event_generator():
        try:
            async for event in _astream_chat_response(payload, request_id, started_at):
                if event["type"] == "sources":
                    data = json.dumps({"sources": event["sources"]})
                    yield f"event: sources\ndata: {data}\n\n"
                elif event["type"] == "token":
                    data = json.dumps({"token": event["token"]})
                    yield f"event: token\ndata: {data}\n\n"
            yield "event: done\ndata: {}\n\n"
            logger.info(
                "chat_stream_response_completed",
                request_id=request_id,
                thread_id=payload.get("thread_id"),
                elapsed_ms=_elapsed_ms(started_at),
            )
        except asyncio.CancelledError:
            logger.warning(
                "chat_stream_client_disconnected",
                request_id=request_id,
                thread_id=payload.get("thread_id"),
                elapsed_ms=_elapsed_ms(started_at),
            )
            raise
        except Exception as err:
            logger.exception(
                "chat_stream_response_failed",
                request_id=request_id,
                thread_id=payload.get("thread_id"),
                elapsed_ms=_elapsed_ms(started_at),
                error=str(err),
            )
            yield f"event: error\ndata: {json.dumps({'message': str(err)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# /chat/ui — AI SDK UI message stream protocol (for `useChat` from @ai-sdk/react)
# https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
# ---------------------------------------------------------------------------

class UIChatRequest(BaseModel):
    """Body sent by the AI SDK's DefaultChatTransport, plus our extra fields."""
    id: str | None = None
    messages: list[Dict[str, Any]] = Field(default_factory=list)
    mode: str = "search"
    filters: dict | None = None
    scope: str | None = None


def _ui_message_text(message: Dict[str, Any]) -> str:
    parts = message.get("parts") or []
    text = "".join(
        str(p.get("text", "")) for p in parts if isinstance(p, dict) and p.get("type") == "text"
    )
    return text or str(message.get("content") or "")


def _ui_request_to_payload(req: UIChatRequest) -> Dict[str, Any]:
    """Turn UIMessages into the graph's question + [{human, ai}] history."""
    messages = req.messages
    last_user = max(
        (i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1
    )
    history: list[Dict[str, str]] = []
    for message in messages[:max(last_user, 0)]:
        role = message.get("role")
        if role == "user":
            history.append({"human": _ui_message_text(message)})
        elif role == "assistant" and history:
            history[-1]["ai"] = _ui_message_text(message)
    return {
        "question": _ui_message_text(messages[last_user]) if last_user >= 0 else "",
        "chat_history": history,
        "mode": req.mode,
        "filters": req.filters,
        "scope": req.scope,
        "thread_id": req.id,
    }


def _ui_chunk(chunk: Dict[str, Any] | str) -> str:
    data = chunk if isinstance(chunk, str) else json.dumps(chunk)
    return f"data: {data}\n\n"


@app.post("/chat/ui")
async def chat_ui(req: UIChatRequest):
    payload = _ui_request_to_payload(req)
    request_id = str(uuid.uuid4())
    started_at = time.perf_counter()
    logger.info(
        "chat_ui_request_started",
        request_id=request_id,
        thread_id=payload.get("thread_id"),
        question_chars=len(payload["question"]),
        question_preview=payload["question"][:160],
        history_turns=len(payload["chat_history"]),
    )

    async def event_generator():
        text_id = "text-0"
        text_started = False
        try:
            yield _ui_chunk({"type": "start", "messageId": f"msg-{uuid.uuid4().hex}"})
            async for event in _astream_chat_response(payload, request_id, started_at):
                if event["type"] == "sources":
                    for i, source in enumerate(event["sources"]):
                        yield _ui_chunk({
                            "type": "source-url",
                            "sourceId": f"src-{i}",
                            "url": source["url"],
                            "title": source["title"],
                            "providerMetadata": {"unep": {"source": source["source"]}},
                        })
                elif event["type"] == "token":
                    if not text_started:
                        text_started = True
                        yield _ui_chunk({"type": "text-start", "id": text_id})
                    yield _ui_chunk({"type": "text-delta", "id": text_id, "delta": event["token"]})
            if text_started:
                yield _ui_chunk({"type": "text-end", "id": text_id})
            yield _ui_chunk({"type": "finish", "finishReason": "stop"})
            logger.info(
                "chat_ui_response_completed",
                request_id=request_id,
                thread_id=payload.get("thread_id"),
                elapsed_ms=_elapsed_ms(started_at),
            )
        except asyncio.CancelledError:
            logger.warning(
                "chat_ui_client_disconnected",
                request_id=request_id,
                thread_id=payload.get("thread_id"),
                elapsed_ms=_elapsed_ms(started_at),
            )
            raise
        except Exception as err:
            logger.exception(
                "chat_ui_response_failed",
                request_id=request_id,
                thread_id=payload.get("thread_id"),
                elapsed_ms=_elapsed_ms(started_at),
                error=str(err),
            )
            yield _ui_chunk({"type": "error", "errorText": str(err)})
        yield _ui_chunk("[DONE]")

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"x-vercel-ai-ui-message-stream": "v1", "Cache-Control": "no-cache"},
    )


# ---------------------------------------------------------------------------
# /search — structured summary endpoint with semantic cache
# ---------------------------------------------------------------------------

class SearchRequest(BaseModel):
    """Request body for /search — single-turn, no chat_history."""
    query: str
    filters: Optional[Dict[str, Any]] = None
    scope: Optional[str] = None
    cited_only: bool = False
    resources_scanned: Optional[int] = None
    total_knowledge_hubs: Optional[int] = None


@app.post("/search", response_model=SummaryResponse)
async def search_endpoint(req: SearchRequest) -> SummaryResponse:
    """
    Single-turn structured search.

    Cache flow:
      1. Lookup → return cached response if similarity ≥ threshold (fast path)
      2. Miss → run the full graph
      3. Store fresh result asynchronously for next time
    """
    if not req.query or not req.query.strip():
        raise HTTPException(status_code=400, detail="query is required")

    filters = _apply_scope(req.filters, req.scope)

    # Cache lookup
    if summary_cache:
        cached = summary_cache.lookup(req.query, filters)
        if cached:
            return cached

    t_start = time.perf_counter()

    initial_state = {
        "question": req.query,
        "chat_history": [],
        "mode": "summary",
        "filters": filters,
        "timings": {},
    }
    final_state = rag_graph.invoke(
        initial_state,
        config=_graph_config({"thread_id": f"search:{uuid.uuid4()}"}),
    )
    elapsed = time.perf_counter() - t_start

    docs = (
        final_state.get("final_docs")
        or final_state.get("reranked_docs")
        or final_state.get("retrieved_docs")
        or []
    )

    summary = final_state.get("structured_summary")
    if summary is None:
        summary = StructuredSummary(
            executive_summary="Summary generation did not complete. Please retry.",
        )

    stats = compute_stats(
        docs=docs,
        total_results_found=len(docs),
        resources_scanned=req.resources_scanned or DEFAULT_RESOURCES_SCANNED,
        total_knowledge_hubs=req.total_knowledge_hubs or DEFAULT_TOTAL_KNOWLEDGE_HUBS,
        elapsed_seconds=elapsed,
    )

    response = build_summary_response(
        question=req.query,
        docs=docs,
        summary=summary,
        stats=stats,
        cited_only=req.cited_only,
    )

    # Store async; never block the response on cache write
    if summary_cache:
        asyncio.create_task(
            asyncio.to_thread(summary_cache.store, req.query, filters, response)
        )

    logger.info(
        "search_completed",
        query=req.query,
        results=len(response.documents),
        elapsed_s=round(elapsed, 3),
        timings=final_state.get("timings", {}),
    )
    return response


# ---------------------------------------------------------------------------
# /chat/events — SSE intermediate-state stream
# ---------------------------------------------------------------------------

_NODE_PROGRESS_LABELS = {
    "classify_intent": "Understanding the question",
    "condense_question": "Resolving references",
    "plan_tools": "Checking if external tools are needed",
    "decide_hyde": "Choosing retrieval strategy",
    "generate_hyde": "Expanding query for retrieval",
    "retrieve_documents": "Searching UNEP documents",
    "rerank_documents": "Reranking results",
    "grade_documents": "Grading relevance",
    "decide_next": "Deciding next step",
    "rewrite_query": "Rephrasing to improve results",
    "format_context": "Preparing context",
    "generate_answer": "Generating answer",
    "generate_summary": "Generating structured summary",
    "clarification_answer": "Preparing a clarification",
}


def _sse_event(event_type: str, data: Dict[str, Any]) -> str:
    return f"event: {event_type}\ndata: {json.dumps(data)}\n\n"


async def _stream_events(req: Dict[str, Any]) -> AsyncIterator[str]:
    initial = _to_initial_state(req)
    config = _graph_config(req)
    try:
        async for part in rag_graph.astream(
            initial,
            config=config,
            stream_mode=["updates", "messages"],
            version="v2",
        ):
            kind = part.get("type")
            if kind == "updates":
                for name, output in (part.get("data") or {}).items():
                    if name not in _NODE_PROGRESS_LABELS:
                        continue
                    diff = _summarize_node_output(name, output or {})
                    yield _sse_event("node_end", {
                        "node": name,
                        "label": _NODE_PROGRESS_LABELS[name],
                        "diff": diff,
                    })
            elif kind == "messages":
                chunk, metadata = part.get("data") or (None, {})
                if metadata.get("langgraph_node") != "generate_answer":
                    continue
                content = getattr(chunk, "content", "") if chunk else ""
                if content:
                    yield _sse_event("token", {"text": content})
        yield _sse_event("done", {})
    except Exception as err:
        logger.exception("stream_events_failed", error=str(err))
        yield _sse_event("error", {"message": str(err)})


def _summarize_node_output(node: str, output: Dict[str, Any]) -> Dict[str, Any]:
    if node == "classify_intent":
        return {
            "intent": output.get("intent"),
            "confidence": output.get("intent_confidence"),
        }
    if node == "condense_question":
        return {"standalone_question": output.get("standalone_question")}
    if node == "plan_tools":
        return {
            "tools_used": [r.get("tool") for r in (output.get("tool_results") or [])],
        }
    if node == "decide_hyde":
        return {"use_hyde": output.get("use_hyde")}
    if node == "generate_hyde":
        hyde = output.get("hyde_query")
        return {"hyde_preview": (hyde[:200] if hyde else None)}
    if node == "retrieve_documents":
        docs = output.get("retrieved_docs") or []
        return {
            "count": len(docs),
            "attempt": output.get("retrieval_attempts"),
            "top_titles": [d.metadata.get("article_title") for d in docs[:3]],
        }
    if node == "rerank_documents":
        return {"count": len(output.get("reranked_docs") or [])}
    if node == "grade_documents":
        return {
            "relevant_count": output.get("relevant_count"),
            "total": len(output.get("grades") or []),
        }
    if node == "decide_next":
        return {"action": output.get("next_action")}
    if node == "rewrite_query":
        return {"new_question": output.get("standalone_question")}
    if node == "generate_summary":
        summary = output.get("structured_summary")
        return {
            "has_summary": summary is not None,
            "exec_preview": (summary.executive_summary[:200] if summary else None),
        }
    return {}


@app.post("/chat/events")
async def chat_events_endpoint(request: Request):
    if not STREAM_INTERMEDIATE_STATE:
        raise HTTPException(
            status_code=404,
            detail="Intermediate-state streaming disabled.",
        )
    body = await request.json()
    req = body.get("input") if "input" in body else body
    if not isinstance(req, dict):
        raise HTTPException(status_code=400, detail="invalid request body")
    return StreamingResponse(
        _stream_events(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# /thread, /admin, /health, /metrics
# ---------------------------------------------------------------------------

@app.get("/thread/{thread_id}")
def get_thread_state(thread_id: str) -> Dict[str, Any]:
    if checkpointer is None:
        raise HTTPException(status_code=404, detail="Checkpointing disabled.")
    snapshot = rag_graph.get_state(config={"configurable": {"thread_id": thread_id}})
    if not snapshot or not snapshot.values:
        raise HTTPException(status_code=404, detail=f"thread {thread_id} not found")
    state = dict(snapshot.values)
    state.pop("retrieved_docs", None)
    state.pop("reranked_docs", None)
    state.pop("final_docs", None)
    return {"thread_id": thread_id, "state": state, "next": snapshot.next}


def _require_admin_token(x_admin_token: Optional[str] = Header(default=None)) -> None:
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Admin token not configured.")
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Forbidden")


@app.post("/admin/cache/flush", dependencies=[Depends(_require_admin_token)])
def flush_cache() -> Dict[str, Any]:
    """
    Flush all cached summary responses. Call after re-indexing chunks_v1 so
    stale answers don't get served.  Requires X-Admin-Token header matching
    the ADMIN_TOKEN environment variable.
    """
    if not summary_cache:
        raise HTTPException(status_code=404, detail="cache disabled")
    return summary_cache.flush()


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "features": {
            "rerank": reranker is not None,
            "tools": list(tools.keys()),
            "checkpoint_provider": CHECKPOINT_PROVIDER,
            "stream_intermediate_state": STREAM_INTERMEDIATE_STATE,
            "summary_cache": summary_cache is not None,
        },
        "endpoints": [
            "/chat", "/chat/stream", "/chat/events",
            "/search", "/thread/{id}", "/admin/cache/flush",
        ],
    }


@app.get("/metrics")
def metrics_endpoint() -> Dict[str, Any]:
    p50, p95 = metrics._latency_percentiles()
    result: Dict[str, Any] = {
        "retriever": {
            "queries_total": metrics.queries_total,
            "hyde_applied_total": metrics.hyde_applied_total,
            "hyde_applied_rate": round(
                metrics.hyde_applied_total / max(1, metrics.queries_total), 4
            ),
            "retrieval_latency_p50_ms": p50,
            "retrieval_latency_p95_ms": p95,
            "branch_avg_top1_score": {
                "_note": "raw top-1 scores, NOT comparable across branches",
                **metrics._branch_avg_top1_score(),
            },
        },
    }
    if summary_cache:
        result["summary_cache"] = summary_cache.stats()
    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
