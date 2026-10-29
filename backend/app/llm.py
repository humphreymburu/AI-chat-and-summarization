"""
LLM client builders.

Five distinct LLMs, each tuned for its role:

  build_chat_llm()         : streaming, temp 0.7  — user-facing answers + condense
  build_hyde_llm()         : non-streaming, temp 0.1 — HyDE rewrites
  build_grading_llm()      : non-streaming, temp 0.0 — relevance grading + rewrite
  build_intent_llm()       : non-streaming, temp 0.0 — intent classification
  build_tool_planner_llm() : non-streaming, temp 0.0 — tool selection

Plus a wrapper:

  build_summary_llm(chat_llm) : binds higher max_tokens for the structured
                                summary node (which needs 800-1500 tokens out)

Provider selection via LLM_PROVIDER env var:
  "openrouter" (default) — ChatOpenAI pointing at OpenRouter
  "azure"                — AzureChatOpenAI using Azure OpenAI Service

NOTE: All specialized LLMs use max_tokens=500 by default — this is high
enough that reasoning models (which emit <think> tokens that count against
max_tokens) have headroom for actual output. Without this, thinking models
return empty content.
"""

from __future__ import annotations

from langchain_openai import AzureChatOpenAI, ChatOpenAI

from app.config import (
    AZURE_OPENAI_API_KEY,
    AZURE_OPENAI_ENDPOINT,
    GRADING_MAX_TOKENS,
    GRADING_MODEL,
    HYDE_MAX_TOKENS,
    HYDE_MODEL,
    INTENT_MAX_TOKENS,
    INTENT_MODEL,
    LLM_PROVIDER,
    OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL,
    OPENROUTER_MODEL,
    SUMMARY_MAX_TOKENS,
    TOOL_PLANNER_MAX_TOKENS,
    TOOL_PLANNER_MODEL,
)


def _is_azure() -> bool:
    return LLM_PROVIDER == "azure"


def build_chat_llm() -> ChatOpenAI:
    """Streaming chat LLM for the final answer and condense step."""
    if _is_azure():
        return AzureChatOpenAI(
            azure_endpoint=AZURE_OPENAI_ENDPOINT,
            api_key=AZURE_OPENAI_API_KEY,
            streaming=True,
            temperature=0.7,
        )
    return ChatOpenAI(
        model=OPENROUTER_MODEL,
        streaming=True,
        temperature=0.7,
        openai_api_key=OPENROUTER_API_KEY,
        openai_api_base=OPENROUTER_BASE_URL,
    )


def build_hyde_llm() -> ChatOpenAI:
    if _is_azure():
        return AzureChatOpenAI(
            azure_endpoint=AZURE_OPENAI_ENDPOINT,
            api_key=AZURE_OPENAI_API_KEY,
            streaming=False,
            temperature=0.1,
            max_tokens=HYDE_MAX_TOKENS,
        )
    return ChatOpenAI(
        model=HYDE_MODEL,
        streaming=False,
        temperature=0.1,
        max_tokens=HYDE_MAX_TOKENS,
        openai_api_key=OPENROUTER_API_KEY,
        openai_api_base=OPENROUTER_BASE_URL,
    )


def build_grading_llm() -> ChatOpenAI:
    if _is_azure():
        return AzureChatOpenAI(
            azure_endpoint=AZURE_OPENAI_ENDPOINT,
            api_key=AZURE_OPENAI_API_KEY,
            streaming=False,
            temperature=0.0,
            max_tokens=GRADING_MAX_TOKENS,
        )
    return ChatOpenAI(
        model=GRADING_MODEL,
        streaming=False,
        temperature=0.0,
        max_tokens=GRADING_MAX_TOKENS,
        openai_api_key=OPENROUTER_API_KEY,
        openai_api_base=OPENROUTER_BASE_URL,
    )


def build_intent_llm() -> ChatOpenAI:
    """Intent classification runs on every request, so prefer a small fast model."""
    if _is_azure():
        return AzureChatOpenAI(
            azure_endpoint=AZURE_OPENAI_ENDPOINT,
            api_key=AZURE_OPENAI_API_KEY,
            streaming=False,
            temperature=0.0,
            max_tokens=INTENT_MAX_TOKENS,
        )
    return ChatOpenAI(
        model=INTENT_MODEL,
        streaming=False,
        temperature=0.0,
        max_tokens=INTENT_MAX_TOKENS,
        openai_api_key=OPENROUTER_API_KEY,
        openai_api_base=OPENROUTER_BASE_URL,
    )


def build_tool_planner_llm() -> ChatOpenAI:
    """Tool planning runs on every on-topic query when tools are enabled."""
    if _is_azure():
        return AzureChatOpenAI(
            azure_endpoint=AZURE_OPENAI_ENDPOINT,
            api_key=AZURE_OPENAI_API_KEY,
            streaming=False,
            temperature=0.0,
            max_tokens=TOOL_PLANNER_MAX_TOKENS,
        )
    return ChatOpenAI(
        model=TOOL_PLANNER_MODEL,
        streaming=False,
        temperature=0.0,
        max_tokens=TOOL_PLANNER_MAX_TOKENS,
        openai_api_key=OPENROUTER_API_KEY,
        openai_api_base=OPENROUTER_BASE_URL,
    )


def build_summary_llm(chat_llm: ChatOpenAI):
    """
    Wrap the shared chat LLM with a higher max_tokens budget for summary mode.

    The five-section structured response routinely needs 800-1500 output tokens.
    Uses LangChain's .bind() so the chat_llm instance is untouched — the
    /chat endpoint keeps its existing budget.
    """
    return chat_llm.bind(max_tokens=SUMMARY_MAX_TOKENS)
