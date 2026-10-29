"""
Intent classification.

Runs before condense_question. Routes the query to one of:

  - "greeting"   : "hi", "hello" → canned friendly reply
  - "smalltalk"  : "thanks", "ok" → brief acknowledgement
  - "off_topic"  : unrelated to UNEP → polite redirect
  - "on_topic"   : the normal RAG flow

A cheap regex pre-classifier catches obvious cases; ambiguous ones fall to
the LLM. Summary mode bypasses intent classification entirely (see graph.py).
"""

from __future__ import annotations

import json
import re
from typing import Literal

import structlog
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

logger = structlog.get_logger(__name__)


IntentLabel = Literal["greeting", "smalltalk", "off_topic", "on_topic"]


INTENT_PROMPT = """Classify the user's message into one of four categories.

UNEP is the United Nations Environment Programme. Its scope includes \
climate, biodiversity, pollution, ecosystems, sustainability, environmental \
policy, environmental treaties (Montreal Protocol, Kigali Amendment, Paris \
Agreement, etc.), green economy, and related topics.

Categories:
- "greeting"   : hello, hi, good morning, how are you
- "smalltalk"  : thanks, ok, got it, bye, no further questions
- "off_topic"  : unrelated to UNEP/environment (weather chitchat, sports, \
coding help, personal advice, math homework that isn't policy analysis)
- "on_topic"   : anything about UNEP, the environment, climate, biodiversity, \
pollution, policy, treaties, sustainability — even casually phrased

Respond with strict JSON in this exact shape, no preamble:
{{"intent": "one_of_the_four_labels", "confidence": 0.0_to_1.0}}

User message: {message}"""


class IntentResult(BaseModel):
    intent: IntentLabel
    confidence: float = Field(default=0.5)


def _parse_intent_output(text: str) -> IntentResult:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    m = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if m:
        cleaned = m.group(0)
    try:
        data = json.loads(cleaned)
        label = data.get("intent", "on_topic")
        if label not in ("greeting", "smalltalk", "off_topic", "on_topic"):
            label = "on_topic"
        conf = float(data.get("confidence", 0.5))
        return IntentResult(intent=label, confidence=conf)
    except Exception as err:
        logger.warning("intent_parse_failed", error=str(err), raw=text[:200])
        # When in doubt, treat as on-topic — better to run RAG on a
        # borderline question than to wrongly refuse it.
        return IntentResult(intent="on_topic", confidence=0.0)


_GREETING_RE = re.compile(
    r"^\s*(hi|hello|hey|good (morning|afternoon|evening)|greetings|howdy)\b[.!?]?\s*$",
    re.IGNORECASE,
)
_SMALLTALK_RE = re.compile(
    r"^\s*(thanks|thank you|thx|ok|okay|got it|cool|nice|alright|sounds good|bye|goodbye)\b[.!?]?\s*$",
    re.IGNORECASE,
)


def classify_intent(llm: ChatOpenAI, message: str) -> IntentResult:
    """Classify with regex pre-pass before falling back to LLM."""
    stripped = message.strip()

    if _GREETING_RE.match(stripped):
        return IntentResult(intent="greeting", confidence=0.95)
    if _SMALLTALK_RE.match(stripped):
        return IntentResult(intent="smalltalk", confidence=0.95)

    prompt = INTENT_PROMPT.format(message=message)
    try:
        response = llm.invoke(prompt)
        text = (getattr(response, "content", "") or "")
        return _parse_intent_output(text)
    except Exception as err:
        logger.warning("intent_classify_failed", error=str(err))
        return IntentResult(intent="on_topic", confidence=0.0)


GREETING_RESPONSE = (
    "Hello! I'm a UNEP assistant. I can help you explore UNEP stories, "
    "publications, speeches, and information about climate, biodiversity, "
    "pollution, ecosystems, and environmental policy. What would you like "
    "to know?"
)

SMALLTALK_RESPONSE = (
    "You're welcome. Let me know if there's anything else about UNEP's work "
    "or environmental topics I can help with."
)

OFF_TOPIC_RESPONSE = (
    "That topic falls outside what I can help with. I'm focused on UNEP — "
    "the United Nations Environment Programme — covering climate change, "
    "biodiversity, pollution, ecosystems, sustainability, and environmental "
    "policy. Is there a related question I can help with?"
)