"""
External tools for the agent.

Built-in tools:
  - web_search : Tavily, SerpAPI, or Brave — for current events / news
  - calculator : Safe AST-based arithmetic for numeric questions

A simple LLM planner decides whether each query needs tools. Tool results
are appended to retrieval context, so the answer LLM sees both.

All gated by env flags. Off by default.
"""

from __future__ import annotations

import ast
import json
import operator
import re
from abc import ABC, abstractmethod
from typing import Any, Dict, List

import structlog
from langchain_openai import ChatOpenAI

from app.config import (
    BRAVE_SEARCH_API_KEY,
    CALCULATOR_ENABLED,
    SERPAPI_API_KEY,
    TAVILY_API_KEY,
    TOOLS_ENABLED,
    WEB_SEARCH_ENABLED,
    WEB_SEARCH_MAX_RESULTS,
    WEB_SEARCH_PROVIDER,
)

logger = structlog.get_logger(__name__)


class Tool(ABC):
    name: str
    description: str

    @abstractmethod
    def call(self, **kwargs) -> str:
        """Execute the tool. Return a string result for inclusion in context."""


# ---------------------------------------------------------------------------
# Calculator (AST-safe — rejects function calls, attribute access, etc.)
# ---------------------------------------------------------------------------

_ALLOWED_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


def _safe_eval(node):
    if isinstance(node, ast.Expression):
        return _safe_eval(node.body)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float)):
            return node.value
        raise ValueError("only numeric literals are allowed")
    if isinstance(node, ast.BinOp):
        op = _ALLOWED_OPS.get(type(node.op))
        if op is None:
            raise ValueError(f"operator {type(node.op).__name__} not allowed")
        return op(_safe_eval(node.left), _safe_eval(node.right))
    if isinstance(node, ast.UnaryOp):
        op = _ALLOWED_OPS.get(type(node.op))
        if op is None:
            raise ValueError(f"unary operator {type(node.op).__name__} not allowed")
        return op(_safe_eval(node.operand))
    raise ValueError(f"AST node {type(node).__name__} not allowed")


class CalculatorTool(Tool):
    name = "calculator"
    description = (
        "Evaluate a mathematical expression with +, -, *, /, %, **, and "
        "parentheses. Input: {\"expression\": \"<math expression>\"}"
    )

    def call(self, expression: str = "", **_) -> str:
        if not expression:
            return "Error: expression is required"
        try:
            tree = ast.parse(expression, mode="eval")
            result = _safe_eval(tree)
            return f"{expression} = {result}"
        except Exception as err:
            return f"Calculator error: {err}"


# ---------------------------------------------------------------------------
# Web search
# ---------------------------------------------------------------------------

class WebSearchTool(Tool):
    name = "web_search"
    description = (
        "Search the public web for current information. Use when the user "
        "asks about events, news, or facts that may have changed since the "
        "indexed UNEP corpus was last updated. "
        "Input: {\"query\": \"<search query>\"}"
    )

    def __init__(self, provider: str):
        self.provider = provider
        import requests
        self._requests = requests
        logger.info("web_search_initialized", provider=provider)

    def call(self, query: str = "", **_) -> str:
        if not query:
            return "Error: query is required"
        try:
            if self.provider == "tavily":
                return self._tavily(query)
            if self.provider == "serpapi":
                return self._serpapi(query)
            if self.provider == "brave":
                return self._brave(query)
            return f"Error: unknown provider '{self.provider}'"
        except Exception as err:
            logger.warning("web_search_failed", provider=self.provider, error=str(err))
            return f"Web search error: {err}"

    def _tavily(self, query: str) -> str:
        if not TAVILY_API_KEY:
            return "Error: TAVILY_API_KEY not configured"
        response = self._requests.post(
            "https://api.tavily.com/search",
            json={
                "api_key": TAVILY_API_KEY,
                "query": query,
                "max_results": WEB_SEARCH_MAX_RESULTS,
                "include_answer": True,
            },
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
        lines: List[str] = []
        if data.get("answer"):
            lines.append(f"Summary: {data['answer']}")
        for result in data.get("results", [])[:WEB_SEARCH_MAX_RESULTS]:
            lines.append(
                f"- {result.get('title', '')}\n"
                f"  {result.get('url', '')}\n"
                f"  {result.get('content', '')[:300]}"
            )
        return "\n".join(lines) or "No results found"

    def _serpapi(self, query: str) -> str:
        if not SERPAPI_API_KEY:
            return "Error: SERPAPI_API_KEY not configured"
        response = self._requests.get(
            "https://serpapi.com/search",
            params={
                "q": query,
                "api_key": SERPAPI_API_KEY,
                "num": WEB_SEARCH_MAX_RESULTS,
            },
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
        lines = []
        for result in data.get("organic_results", [])[:WEB_SEARCH_MAX_RESULTS]:
            lines.append(
                f"- {result.get('title', '')}\n"
                f"  {result.get('link', '')}\n"
                f"  {result.get('snippet', '')[:300]}"
            )
        return "\n".join(lines) or "No results found"

    def _brave(self, query: str) -> str:
        if not BRAVE_SEARCH_API_KEY:
            return "Error: BRAVE_SEARCH_API_KEY not configured"
        response = self._requests.get(
            "https://api.search.brave.com/res/v1/web/search",
            params={"q": query, "count": WEB_SEARCH_MAX_RESULTS},
            headers={
                "X-Subscription-Token": BRAVE_SEARCH_API_KEY,
                "Accept": "application/json",
            },
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
        lines = []
        for result in data.get("web", {}).get("results", [])[:WEB_SEARCH_MAX_RESULTS]:
            lines.append(
                f"- {result.get('title', '')}\n"
                f"  {result.get('url', '')}\n"
                f"  {result.get('description', '')[:300]}"
            )
        return "\n".join(lines) or "No results found"


def build_tools() -> Dict[str, Tool]:
    if not TOOLS_ENABLED:
        return {}

    tools: Dict[str, Tool] = {}
    if CALCULATOR_ENABLED:
        tools["calculator"] = CalculatorTool()
    if WEB_SEARCH_ENABLED:
        tools["web_search"] = WebSearchTool(provider=WEB_SEARCH_PROVIDER)

    logger.info("tools_built", enabled=list(tools.keys()))
    return tools


# ---------------------------------------------------------------------------
# Tool planner
# ---------------------------------------------------------------------------

TOOL_PLANNER_PROMPT = """You decide whether the user's question requires \
calling external tools beyond the indexed UNEP document corpus.

Available tools:
{tool_descriptions}

Decide:
  - If answerable from UNEP documents alone, output {{"use_tools": false, "calls": []}}
  - If current info or arithmetic is required, output the tool calls needed

Examples:
  Q: "What is the Kigali Amendment?" → no tools (corpus has it)
  Q: "What is the current price of carbon credits?" → web_search
  Q: "What is 4.5% of $50 billion?" → calculator
  Q: "How has UNEP responded to recent floods in Pakistan?" → web_search

Output strict JSON. Examples:
{{"use_tools": false, "calls": []}}
{{"use_tools": true, "calls": [{{"tool": "web_search", "args": {{"query": "..."}}}}]}}

User question: {question}

Decision:"""


class ToolPlan:
    def __init__(self, use_tools: bool, calls: List[Dict[str, Any]]):
        self.use_tools = use_tools
        self.calls = calls


def _parse_tool_plan(text: str, allowed_tools: List[str]) -> ToolPlan:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    m = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if m:
        cleaned = m.group(0)
    try:
        data = json.loads(cleaned)
    except Exception as err:
        logger.warning("tool_plan_parse_failed", error=str(err), raw=text[:200])
        return ToolPlan(use_tools=False, calls=[])

    use_tools = bool(data.get("use_tools", False))
    raw_calls = data.get("calls") or []

    # Validate calls — never invoke an unregistered tool even if the planner
    # hallucinates one.
    calls: List[Dict[str, Any]] = []
    for call in raw_calls:
        if not isinstance(call, dict):
            continue
        tool_name = call.get("tool")
        if tool_name not in allowed_tools:
            logger.warning(
                "tool_plan_rejected_unknown_tool",
                tool=tool_name,
                allowed=allowed_tools,
            )
            continue
        args = call.get("args") or {}
        if not isinstance(args, dict):
            args = {}
        calls.append({"tool": tool_name, "args": args})

    return ToolPlan(use_tools=use_tools and bool(calls), calls=calls)


def plan_tools(llm: ChatOpenAI, question: str, tools: Dict[str, Tool]) -> ToolPlan:
    if not tools:
        return ToolPlan(use_tools=False, calls=[])

    descriptions = "\n".join(
        f"  - {name}: {tool.description}" for name, tool in tools.items()
    )
    prompt = TOOL_PLANNER_PROMPT.format(
        tool_descriptions=descriptions,
        question=question,
    )
    try:
        response = llm.invoke(prompt)
        text = (getattr(response, "content", "") or "")
        plan = _parse_tool_plan(text, allowed_tools=list(tools.keys()))
        logger.info(
            "tool_plan",
            use_tools=plan.use_tools,
            calls=[c["tool"] for c in plan.calls],
        )
        return plan
    except Exception as err:
        logger.warning("tool_plan_llm_failed", error=str(err))
        return ToolPlan(use_tools=False, calls=[])


def execute_tools(plan: ToolPlan, tools: Dict[str, Tool]) -> List[Dict[str, str]]:
    results: List[Dict[str, str]] = []
    for call in plan.calls:
        tool = tools.get(call["tool"])
        if tool is None:
            continue
        result = tool.call(**call["args"])
        results.append({
            "tool": call["tool"],
            "args": json.dumps(call["args"]),
            "result": result,
        })
        logger.info(
            "tool_executed",
            tool=call["tool"],
            args=call["args"],
            result_preview=str(result)[:200],
        )
    return results


def format_tool_results(results: List[Dict[str, str]]) -> str:
    if not results:
        return ""
    blocks = []
    for r in results:
        blocks.append(
            f"<tool name='{r['tool']}' args='{r['args']}'>\n"
            f"{r['result']}\n"
            f"</tool>"
        )
    return "\n".join(blocks)