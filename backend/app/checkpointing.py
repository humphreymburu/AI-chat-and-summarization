"""
Checkpointing for resumable conversations.

LangGraph supports checkpointing via the BaseCheckpointSaver interface.
A checkpointed graph:
  - Persists state at every super-step
  - Allows resuming a conversation by thread_id
  - Survives server restarts (with sqlite or redis backends)

Provider selection via CHECKPOINT_PROVIDER:
  - "none"   : no checkpointing (default; stateless across requests)
  - "memory" : in-process dict (resets on restart; for dev)
  - "sqlite" : SQLite file (production-ready, single-instance)
  - "redis"  : Redis (production-ready, multi-instance / horizontal scale)

Both functions return (checkpointer, teardown).  Always call teardown on
application shutdown to release connections.  Inside a FastAPI lifespan handler
use build_checkpointer_async(), which uses AsyncSqliteSaver for the sqlite
provider and returns an awaitable teardown.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Callable, Optional, Tuple

import structlog

from app.config import (
    CHECKPOINT_PROVIDER,
    CHECKPOINT_REDIS_URL,
    CHECKPOINT_SQLITE_PATH,
)

logger = structlog.get_logger(__name__)


def build_checkpointer() -> Tuple[Optional[Any], Callable[[], None]]:
    """
    Return (checkpointer, teardown_fn).

    teardown_fn() is synchronous.  For async contexts prefer
    build_checkpointer_async() so the teardown can be awaited.
    """
    if CHECKPOINT_PROVIDER == "none":
        logger.info("checkpointing_disabled")
        return None, lambda: None

    if CHECKPOINT_PROVIDER == "memory":
        from langgraph.checkpoint.memory import InMemorySaver
        logger.info("checkpointing_initialized", provider="memory")
        return InMemorySaver(), lambda: None

    if CHECKPOINT_PROVIDER == "sqlite":
        try:
            from langgraph.checkpoint.sqlite import SqliteSaver
        except ImportError as err:
            raise ImportError(
                "SQLite checkpointing requires `langgraph-checkpoint-sqlite`. "
                "Install with: pip install langgraph-checkpoint-sqlite"
            ) from err
        conn = sqlite3.connect(CHECKPOINT_SQLITE_PATH, check_same_thread=False)
        logger.info(
            "checkpointing_initialized",
            provider="sqlite",
            path=CHECKPOINT_SQLITE_PATH,
        )
        return SqliteSaver(conn), conn.close

    if CHECKPOINT_PROVIDER == "redis":
        try:
            from langgraph.checkpoint.redis import RedisSaver
        except ImportError as err:
            raise ImportError(
                "Redis checkpointing requires `langgraph-checkpoint-redis`. "
                "Install with: pip install langgraph-checkpoint-redis"
            ) from err
        cm = RedisSaver.from_conn_string(CHECKPOINT_REDIS_URL)
        saver = cm.__enter__()
        logger.info(
            "checkpointing_initialized",
            provider="redis",
            url=CHECKPOINT_REDIS_URL,
        )
        return saver, lambda: cm.__exit__(None, None, None)

    raise ValueError(
        f"Unknown CHECKPOINT_PROVIDER='{CHECKPOINT_PROVIDER}'. "
        "Use 'none', 'memory', 'sqlite', or 'redis'."
    )


async def build_checkpointer_async() -> Tuple[Optional[Any], Any]:
    """
    Async-aware variant for use inside a FastAPI lifespan handler.

    SQLite uses AsyncSqliteSaver so checkpoint reads/writes don't block the
    event loop via LangGraph's internal thread pool.  Redis and memory fall
    back to their sync savers with an async-wrapped teardown.

    Returns (checkpointer, async_teardown) where async_teardown is always an
    async callable — await it in the lifespan shutdown path.
    """
    if CHECKPOINT_PROVIDER == "sqlite":
        try:
            from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
        except ImportError as err:
            raise ImportError(
                "Async SQLite checkpointing requires `langgraph-checkpoint-sqlite`. "
                "Install with: pip install langgraph-checkpoint-sqlite"
            ) from err
        cm = AsyncSqliteSaver.from_conn_string(CHECKPOINT_SQLITE_PATH)
        saver = await cm.__aenter__()
        logger.info(
            "checkpointing_initialized",
            provider="sqlite_async",
            path=CHECKPOINT_SQLITE_PATH,
        )

        async def _sqlite_teardown() -> None:
            await cm.__aexit__(None, None, None)

        return saver, _sqlite_teardown

    # none / memory / redis — delegate to sync builder, wrap teardown as async.
    saver, sync_teardown = build_checkpointer()

    async def _sync_wrapped_teardown() -> None:
        sync_teardown()

    return saver, _sync_wrapped_teardown
