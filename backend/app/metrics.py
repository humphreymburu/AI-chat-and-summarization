"""
Retriever metrics with structlog-based output.

Tracks rolling samples of latency and per-branch raw scores. Note: branch
scores are RAW (BM25 or cosine), NOT comparable across branches and NOT
normalized through the search pipeline. The metric is informational, not a
"branch contribution to final ranking" measurement.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

import structlog

logger = structlog.get_logger(__name__)


class RetrieverMetrics:
    def __init__(self) -> None:
        self.queries_total = 0
        self.hyde_applied_total = 0
        self.latency_ms_samples: List[int] = []
        self.branch_score_samples: Dict[str, List[float]] = {
            "lexical": [],
            "embedding": [],
            "summary_embedding": [],
            "questions_embedding": [],
        }

    def record_query(self, elapsed_ms: int, hyde_applied: bool) -> None:
        self.queries_total += 1
        if hyde_applied:
            self.hyde_applied_total += 1
        self.latency_ms_samples.append(elapsed_ms)
        if len(self.latency_ms_samples) > 200:
            del self.latency_ms_samples[:-200]

    def record_branch_score(self, name: str, score: float) -> None:
        if name not in self.branch_score_samples:
            return
        samples = self.branch_score_samples[name]
        samples.append(score)
        if len(samples) > 200:
            del samples[:-200]

    def _latency_percentiles(self) -> Tuple[int, int]:
        values = sorted(self.latency_ms_samples)
        if not values:
            return 0, 0

        def pct(p: float) -> int:
            idx = max(0, min(int(round((len(values) - 1) * p)), len(values) - 1))
            return int(values[idx])

        return pct(0.5), pct(0.95)

    def _branch_avg_top1_score(self) -> Dict[str, float]:
        return {
            key: round(sum(samples) / len(samples), 6) if samples else 0.0
            for key, samples in self.branch_score_samples.items()
        }

    def log_snapshot(self) -> None:
        p50, p95 = self._latency_percentiles()
        logger.info(
            "retriever_metrics_snapshot",
            queries_total=self.queries_total,
            hyde_applied_rate=round(
                self.hyde_applied_total / max(1, self.queries_total), 4
            ),
            retrieval_latency_p50_ms=p50,
            retrieval_latency_p95_ms=p95,
            branch_avg_top1_score=self._branch_avg_top1_score(),
        )