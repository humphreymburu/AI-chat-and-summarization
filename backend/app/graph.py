"""
Agentic RAG graph.

Three response modes (routed by state.mode):
  - "search"  : conversational answer (default) — chat mode
  - "rag"     : same as search but returns more chunks for LLM context
  - "summary" : structured GGKP-style audience-segmented summary with citations

Graph shape:

    START
      ↓
    classify_intent ──(non-on-topic)──► canned ──► END
      │ on_topic
      ▼
    condense_question
      ↓
    plan_tools
      ↓
    decide_hyde
      ├── generate_hyde ──┐
      └── skip_hyde   ────┤
                          ▼
                  retrieve_documents ◄────┐
                          ↓               │
                  rerank_documents        │ loop
                          ↓               │
                  grade_documents         │
                          ↓               │
                  decide_next             │
                          │               │
              ┌───────────┼───────────┐   │
              ▼           ▼           ▼   │
        format_      rewrite_      clarif │
        context      query        answer  │
              │           └───────────────┘
              ▼
       decide_answer_mode
              │
       ┌──────┴───────┐
       ▼              ▼
  generate_      generate_
   answer        summary
       ↓              ↓
      END            END
"""

from __future__ import annotations

import html
import re
import time
from typing import Any, Dict, List, Optional, TypedDict

import structlog
from langchain_core.documents import Document
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph

from app.config import INTENT_ENABLED, MAX_TOOL_ITERATIONS, TOOLS_ENABLED
from app.grading import GradeResult, grade_documents, rewrite_query
from app.hyde import generate_hyde, should_use_hyde
from app.intent import (
    GREETING_RESPONSE,
    OFF_TOPIC_RESPONSE,
    SMALLTALK_RESPONSE,
    IntentLabel,
    classify_intent,
)
from app.prompts import (
    ANSWER_TEMPLATE,
    CONDENSE_QUESTION_PROMPT,
    REFERENTIAL_PATTERN,
)
from app.reranker import DEFAULT_RERANK_TOP_N, Reranker
from app.retriever import OpenSearchHybridRetriever
from app.summary import StructuredSummary, generate_structured_summary
from app.tools import Tool, execute_tools, format_tool_results, plan_tools

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Adaptive retrieval bounds
# ---------------------------------------------------------------------------

MAX_RETRIEVAL_ATTEMPTS = 2
MIN_RELEVANT_DOCS = 3
GRADE_TOP_N = 8


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

class RAGState(TypedDict, total=False):
    # Inputs
    question: str
    chat_history: List[Dict[str, Any]]
    mode: str
    filters: Optional[Dict[str, Any]]

    # Intent
    intent: IntentLabel
    intent_confidence: float

    # Condense
    standalone_question: str

    # Tools
    tool_results: List[Dict[str, str]]
    tool_results_formatted: str

    # HyDE
    use_hyde: bool
    hyde_query: Optional[str]
    vector_query_text: str

    # Retrieval
    retrieved_docs: List[Document]
    retrieval_attempts: int
    last_retrieval_reason: str

    # Reranking
    reranked_docs: List[Document]

    # Grading
    grades: List[GradeResult]
    relevant_count: int

    # Routing
    next_action: str

    # Final
    context: str
    answer: str
    structured_summary: StructuredSummary
    final_docs: List[Document]

    # Diagnostics
    timings: Dict[str, int]


def _now_ms() -> int:
    return int(time.perf_counter() * 1000)


def _add_timing(state: RAGState, key: str, ms: int) -> Dict[str, int]:
    timings = dict(state.get("timings") or {})
    timings[key] = ms
    return timings


# ---------------------------------------------------------------------------
# Intent
# ---------------------------------------------------------------------------

def make_intent_node(intent_llm: ChatOpenAI):
    def node(state: RAGState) -> Dict[str, Any]:
        t0 = _now_ms()
        if not INTENT_ENABLED:
            return {
                "intent": "on_topic",
                "intent_confidence": 1.0,
                "timings": _add_timing(state, "intent_ms", _now_ms() - t0),
            }
        result = classify_intent(intent_llm, state["question"])
        logger.info(
            "intent_classified",
            intent=result.intent,
            confidence=result.confidence,
            question_preview=state["question"][:120],
        )
        return {
            "intent": result.intent,
            "intent_confidence": result.confidence,
            "timings": _add_timing(state, "intent_ms", _now_ms() - t0),
        }
    return node


def route_after_intent(state: RAGState) -> str:
    intent = state.get("intent", "on_topic")
    # Summary mode bypasses canned responses — users typing "climate change"
    # should get the summary, not "Hello!"
    if state.get("mode") == "summary":
        return "condense_question"
    if intent == "greeting":
        return "greeting_response"
    if intent == "smalltalk":
        return "smalltalk_response"
    if intent == "off_topic":
        return "off_topic_response"
    return "condense_question"


def greeting_response(state: RAGState) -> Dict[str, Any]:
    return {"answer": GREETING_RESPONSE}


def smalltalk_response(state: RAGState) -> Dict[str, Any]:
    return {"answer": SMALLTALK_RESPONSE}


def off_topic_response(state: RAGState) -> Dict[str, Any]:
    return {"answer": OFF_TOPIC_RESPONSE}


# ---------------------------------------------------------------------------
# Condense
# ---------------------------------------------------------------------------

def make_condense_node(chat_llm: ChatOpenAI):
    chain = (CONDENSE_QUESTION_PROMPT | chat_llm | StrOutputParser()) \
        .with_config(run_name="CondenseQuestion")

    def node(state: RAGState) -> Dict[str, Any]:
        t0 = _now_ms()
        question = state["question"]
        history = state.get("chat_history") or []

        # Skip when summary mode (single-turn), no history, or no pronouns
        if state.get("mode") == "summary" or not history or not REFERENTIAL_PATTERN.search(question):
            return {
                "standalone_question": question,
                "retrieval_attempts": 0,
                "timings": _add_timing(state, "condense_ms", _now_ms() - t0),
            }

        try:
            standalone = chain.invoke({
                "chat_history": _format_history_text(history),
                "question": question,
            })
            logger.info("condense_applied", original=question, standalone=standalone)
        except Exception as err:
            logger.warning("condense_failed", error=str(err))
            standalone = question

        return {
            "standalone_question": standalone,
            "retrieval_attempts": 0,
            "timings": _add_timing(state, "condense_ms", _now_ms() - t0),
        }
    return node


def _format_history_text(history: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    for msg in history:
        if msg.get("human"):
            lines.append(f"Human: {msg['human']}")
        if msg.get("ai"):
            lines.append(f"Assistant: {msg['ai']}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Tool planner
# ---------------------------------------------------------------------------

def make_tool_planner_node(planner_llm: ChatOpenAI, tools: Dict[str, Tool]):
    def node(state: RAGState) -> Dict[str, Any]:
        t0 = _now_ms()
        # Summary mode is corpus-only — no tool calling
        if state.get("mode") == "summary" or not TOOLS_ENABLED or not tools:
            return {
                "tool_results": [],
                "tool_results_formatted": "",
                "timings": _add_timing(state, "tool_plan_ms", _now_ms() - t0),
            }
        plan = plan_tools(planner_llm, state["standalone_question"], tools)
        if not plan.use_tools:
            return {
                "tool_results": [],
                "tool_results_formatted": "",
                "timings": _add_timing(state, "tool_plan_ms", _now_ms() - t0),
            }
        plan.calls = plan.calls[:MAX_TOOL_ITERATIONS]
        results = execute_tools(plan, tools)
        return {
            "tool_results": results,
            "tool_results_formatted": format_tool_results(results),
            "timings": _add_timing(state, "tool_exec_ms", _now_ms() - t0),
        }
    return node


# ---------------------------------------------------------------------------
# HyDE
# ---------------------------------------------------------------------------

def decide_hyde(state: RAGState) -> Dict[str, Any]:
    return {"use_hyde": should_use_hyde(state["standalone_question"])}


def route_after_decide_hyde(state: RAGState) -> str:
    return "generate_hyde" if state.get("use_hyde") else "skip_hyde"


def make_hyde_node(hyde_llm: ChatOpenAI):
    def node(state: RAGState) -> Dict[str, Any]:
        t0 = _now_ms()
        query = state["standalone_question"]
        hyde = generate_hyde(hyde_llm, query)
        return {
            "hyde_query": hyde,
            "vector_query_text": hyde or query,
            "timings": _add_timing(state, "hyde_ms", _now_ms() - t0),
        }
    return node


def skip_hyde(state: RAGState) -> Dict[str, Any]:
    return {
        "hyde_query": None,
        "vector_query_text": state["standalone_question"],
    }


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------

def make_retrieve_node(retriever: OpenSearchHybridRetriever):
    def node(state: RAGState) -> Dict[str, Any]:
        t0 = _now_ms()
        attempts = state.get("retrieval_attempts", 0) + 1
        # Apply default langcode filter when none supplied at the graph layer
        filters = state.get("filters")
        if not filters:
            filters = {"langcode": "en"}
        docs = retriever.search_with_text(
            lexical_query=state["standalone_question"],
            vector_query_text=state["vector_query_text"],
            mode=state.get("mode") or "search",
            filters=filters,
            hyde_applied=state.get("use_hyde", False),
        )
        return {
            "retrieved_docs": docs,
            "retrieval_attempts": attempts,
            "timings": _add_timing(state, f"retrieve_{attempts}_ms", _now_ms() - t0),
        }
    return node


# ---------------------------------------------------------------------------
# Reranking
# ---------------------------------------------------------------------------

def make_rerank_node(reranker: Optional[Reranker]):
    def node(state: RAGState) -> Dict[str, Any]:
        t0 = _now_ms()
        docs = state.get("retrieved_docs") or []
        if reranker is None or not docs:
            return {
                "reranked_docs": docs,
                "timings": _add_timing(state, "rerank_ms", _now_ms() - t0),
            }
        try:
            reranked = reranker.rerank(
                query=state["standalone_question"],
                docs=docs,
                top_n=DEFAULT_RERANK_TOP_N,
            )
            return {
                "reranked_docs": reranked,
                "timings": _add_timing(state, "rerank_ms", _now_ms() - t0),
            }
        except Exception as err:
            logger.warning("rerank_failed", error=str(err))
            return {
                "reranked_docs": docs,
                "timings": _add_timing(state, "rerank_ms", _now_ms() - t0),
            }
    return node


# ---------------------------------------------------------------------------
# Grading
# ---------------------------------------------------------------------------

def make_grader_node(grading_llm: ChatOpenAI):
    def node(state: RAGState) -> Dict[str, Any]:
        t0 = _now_ms()
        docs = state.get("reranked_docs") or state.get("retrieved_docs") or []
        if not docs:
            return {
                "grades": [],
                "relevant_count": 0,
                "timings": _add_timing(state, "grade_ms", _now_ms() - t0),
            }
        grades = grade_documents(
            grading_llm,
            state["standalone_question"],
            docs,
            max_grade=GRADE_TOP_N,
        )
        relevant_count = sum(1 for g in grades if g.relevant)
        return {
            "grades": grades,
            "relevant_count": relevant_count,
            "timings": _add_timing(state, "grade_ms", _now_ms() - t0),
        }
    return node


# ---------------------------------------------------------------------------
# decide_next
# ---------------------------------------------------------------------------

def decide_next(state: RAGState) -> Dict[str, Any]:
    relevant_count = state.get("relevant_count", 0)
    attempts = state.get("retrieval_attempts", 0)
    has_tool_results = bool(state.get("tool_results_formatted"))
    threshold = 1 if has_tool_results else MIN_RELEVANT_DOCS

    if relevant_count >= threshold:
        return {"next_action": "answer"}

    if attempts >= MAX_RETRIEVAL_ATTEMPTS:
        if relevant_count > 0 or has_tool_results:
            return {"next_action": "answer"}
        # Summary mode answers with what it has rather than asking to clarify
        if state.get("mode") == "summary":
            return {"next_action": "answer"}
        return {"next_action": "clarify"}

    grades = state.get("grades") or []
    not_relevant_reasons = [g.reason for g in grades if not g.relevant]
    reason = not_relevant_reasons[0] if not_relevant_reasons else "no documents retrieved"
    return {"next_action": "rewrite", "last_retrieval_reason": reason}


def route_after_decide_next(state: RAGState) -> str:
    return state.get("next_action", "answer")


# ---------------------------------------------------------------------------
# Rewrite
# ---------------------------------------------------------------------------

def make_rewrite_node(grading_llm: ChatOpenAI):
    def node(state: RAGState) -> Dict[str, Any]:
        t0 = _now_ms()
        new_question = rewrite_query(
            grading_llm,
            state["standalone_question"],
            state.get("last_retrieval_reason", "low relevance"),
        )
        attempt_no = state.get("retrieval_attempts", 0)
        return {
            "standalone_question": new_question,
            "vector_query_text": new_question,
            "hyde_query": None,
            "timings": _add_timing(state, f"rewrite_{attempt_no}_ms", _now_ms() - t0),
        }
    return node


# ---------------------------------------------------------------------------
# format_context
# ---------------------------------------------------------------------------

def format_context(state: RAGState) -> Dict[str, Any]:
    docs = state.get("reranked_docs") or state.get("retrieved_docs") or []
    grades = state.get("grades") or []

    if grades and len(grades) >= len(docs):
        relevant_docs = [d for d, g in zip(docs, grades) if g.relevant]
    else:
        relevant_docs = docs

    parts: List[str] = []
    if relevant_docs:
        parts.append("\n".join(
            f"<doc id='{i}' title='{_safe(d.metadata.get('article_title'))}' "
            f"section='{_safe(d.metadata.get('section_heading'))}' "
            f"date='{_safe(d.metadata.get('publication_date'))}' "
            f"url='{_safe(d.metadata.get('article_url'))}'>"
            f"{d.page_content}</doc>"
            for i, d in enumerate(relevant_docs)
        ))
    tool_results = state.get("tool_results_formatted")
    if tool_results:
        parts.append(tool_results)

    return {
        "context": "\n".join(parts) if parts else "(no relevant documents or tool results)",
        "final_docs": relevant_docs,
    }


def _safe(value: Any) -> str:
    if value is None:
        return ""
    return str(value).replace("'", "&#39;").replace("\n", " ")


# ---------------------------------------------------------------------------
# Answer-mode routing
# ---------------------------------------------------------------------------

def decide_answer_mode(state: RAGState) -> Dict[str, Any]:
    """No-op node; routing happens in conditional edges."""
    return {}


def route_to_answer_node(state: RAGState) -> str:
    mode = (state.get("mode") or "search").lower()
    if mode == "summary":
        return "generate_summary"
    return "generate_answer"


# ---------------------------------------------------------------------------
# Answer post-processing
# ---------------------------------------------------------------------------

def _clean_answer(text: str) -> str:
    """Convert HTML markup to Markdown and strip any remaining tags."""
    # Block-level tags → newlines first
    text = re.sub(r"<hr\s*/?>", "\n---\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    # Inline formatting → Markdown equivalents
    text = re.sub(r"<strong>(.*?)</strong>", r"**\1**", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<em>(.*?)</em>", r"*\1*", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<b>(.*?)</b>", r"**\1**", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<i>(.*?)</i>", r"*\1*", text, flags=re.IGNORECASE | re.DOTALL)
    # List tags
    text = re.sub(r"<li>(.*?)</li>", r"- \1", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"</?(?:ul|ol)>", "\n", text, flags=re.IGNORECASE)
    # Strip any remaining HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    # Decode HTML entities (&quot; → ", &amp; → &, etc.)
    text = html.unescape(text)
    # Collapse more than two consecutive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ---------------------------------------------------------------------------
# Answer generators
# ---------------------------------------------------------------------------

def make_answer_node(chat_llm: ChatOpenAI):
    prompt = ChatPromptTemplate.from_messages([
        ("system", ANSWER_TEMPLATE),
        MessagesPlaceholder(variable_name="chat_history_messages"),
        ("human", "{question}"),
    ])
    chain = (prompt | chat_llm | StrOutputParser()) \
        .with_config(run_name="GenerateAnswer")

    def node(state: RAGState) -> Dict[str, Any]:
        t0 = _now_ms()
        history_msgs = _serialize_history_messages(state.get("chat_history") or [])
        raw = chain.invoke({
            "context": state.get("context", ""),
            "question": state["question"],
            "chat_history_messages": history_msgs,
        })
        timings = _add_timing(state, "generate_ms", _now_ms() - t0)
        timings["total_ms"] = sum(v for v in timings.values())
        return {"answer": _clean_answer(raw), "timings": timings}
    return node


def make_summary_node(summary_llm):
    """
    Summary mode answer generator. Uses the high-token-budget summary_llm
    (chat_llm wrapped with SUMMARY_MAX_TOKENS via .bind()).
    """
    def node(state: RAGState) -> Dict[str, Any]:
        t0 = _now_ms()
        docs = (
            state.get("final_docs")
            or state.get("reranked_docs")
            or state.get("retrieved_docs")
            or []
        )
        summary = generate_structured_summary(
            summary_llm=summary_llm,
            question=state["question"],
            docs=docs,
        )
        timings = _add_timing(state, "generate_ms", _now_ms() - t0)
        timings["total_ms"] = sum(v for v in timings.values())
        return {
            "structured_summary": summary,
            "timings": timings,
        }
    return node


def clarification_answer(state: RAGState) -> Dict[str, Any]:
    original = state.get("question", "")
    rewritten = state.get("standalone_question", original)
    parts = [
        "I wasn't able to find UNEP material that directly addresses your question.",
    ]
    if rewritten and rewritten != original:
        parts.append(
            f"I tried searching for a rephrased version ('{rewritten}') as well, "
            "but the results weren't a strong match."
        )
    parts.append(
        "Could you provide more context — for example, the specific topic, "
        "region, programme, or time period you're interested in?"
    )
    return {"answer": " ".join(parts)}


def _serialize_history_messages(history: List[Dict[str, Any]]):
    messages = []
    for msg in history:
        if msg.get("human") is not None:
            messages.append(HumanMessage(content=msg["human"]))
        if msg.get("ai") is not None:
            ai_kwargs: Dict[str, Any] = {}
            if msg.get("reasoning_details") is not None:
                ai_kwargs["reasoning_details"] = msg["reasoning_details"]
            messages.append(AIMessage(content=msg["ai"], additional_kwargs=ai_kwargs))
    return messages


# ---------------------------------------------------------------------------
# Graph assembly
# ---------------------------------------------------------------------------

def build_rag_graph(
    chat_llm: ChatOpenAI,
    hyde_llm: ChatOpenAI,
    grading_llm: ChatOpenAI,
    intent_llm: ChatOpenAI,
    tool_planner_llm: ChatOpenAI,
    summary_llm,
    retriever: OpenSearchHybridRetriever,
    reranker: Optional[Reranker] = None,
    tools: Optional[Dict[str, Tool]] = None,
    checkpointer=None,
):
    """Compile the agentic RAG graph with all features wired in."""
    tools = tools or {}
    g = StateGraph(RAGState)

    g.add_node("classify_intent", make_intent_node(intent_llm))
    g.add_node("greeting_response", greeting_response)
    g.add_node("smalltalk_response", smalltalk_response)
    g.add_node("off_topic_response", off_topic_response)
    g.add_node("condense_question", make_condense_node(chat_llm))
    g.add_node("plan_tools", make_tool_planner_node(tool_planner_llm, tools))
    g.add_node("decide_hyde", decide_hyde)
    g.add_node("generate_hyde", make_hyde_node(hyde_llm))
    g.add_node("skip_hyde", skip_hyde)
    g.add_node("retrieve_documents", make_retrieve_node(retriever))
    g.add_node("rerank_documents", make_rerank_node(reranker))
    g.add_node("grade_documents", make_grader_node(grading_llm))
    g.add_node("decide_next", decide_next)
    g.add_node("rewrite_query", make_rewrite_node(grading_llm))
    g.add_node("format_context", format_context)
    g.add_node("decide_answer_mode", decide_answer_mode)
    g.add_node("generate_answer", make_answer_node(chat_llm))
    g.add_node("generate_summary", make_summary_node(summary_llm))
    g.add_node("clarification_answer", clarification_answer)

    # Entry: intent routing
    g.add_edge(START, "classify_intent")
    g.add_conditional_edges(
        "classify_intent",
        route_after_intent,
        {
            "greeting_response": "greeting_response",
            "smalltalk_response": "smalltalk_response",
            "off_topic_response": "off_topic_response",
            "condense_question": "condense_question",
        },
    )
    g.add_edge("greeting_response", END)
    g.add_edge("smalltalk_response", END)
    g.add_edge("off_topic_response", END)

    # Main path
    g.add_edge("condense_question", "plan_tools")
    g.add_edge("plan_tools", "decide_hyde")

    g.add_conditional_edges(
        "decide_hyde",
        route_after_decide_hyde,
        {"generate_hyde": "generate_hyde", "skip_hyde": "skip_hyde"},
    )
    g.add_edge("generate_hyde", "retrieve_documents")
    g.add_edge("skip_hyde", "retrieve_documents")

    g.add_edge("retrieve_documents", "rerank_documents")
    g.add_edge("rerank_documents", "grade_documents")
    g.add_edge("grade_documents", "decide_next")

    g.add_conditional_edges(
        "decide_next",
        route_after_decide_next,
        {
            "answer": "format_context",
            "rewrite": "rewrite_query",
            "clarify": "clarification_answer",
        },
    )
    g.add_edge("rewrite_query", "decide_hyde")

    # Answer-mode routing
    g.add_edge("format_context", "decide_answer_mode")
    g.add_conditional_edges(
        "decide_answer_mode",
        route_to_answer_node,
        {
            "generate_answer": "generate_answer",
            "generate_summary": "generate_summary",
        },
    )

    g.add_edge("generate_answer", END)
    g.add_edge("generate_summary", END)
    g.add_edge("clarification_answer", END)

    if checkpointer is not None:
        return g.compile(checkpointer=checkpointer)
    return g.compile()
