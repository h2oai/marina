# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Retry a memory call: the same request and key again, the TypeScript SDK's rules exactly."""

from __future__ import annotations

import time
from typing import Callable, Optional, TypeVar

from .http import ApiError, NetworkError

T = TypeVar("T")

RETRY_STATUSES = frozenset({408, 429, 502, 503, 504})
"""HTTP statuses worth the same request again."""
RATE_LIMIT_WAIT_CAP_MS = 30_000
"""The most time spent, in all, waiting out named rate limits before giving up."""
RATE_LIMIT_MARGIN_MS = 5
"""Timers may fire early: wait this much past a named rate-limit wait."""
LONGEST_SERVER_WAIT_MS = 5_000
"""A server asking for a longer wait than this gets its error handed back to the caller."""


def backoff_ms(attempt: int, requested: Optional[float] = None) -> float:
    """Milliseconds before retry `attempt` (1 for the first): 250 doubling to 2000, or the server's wait if longer."""
    return max(requested or 0, min(2000, 250 * 2 ** (attempt - 1)))


def retry_memory(
    operation: Callable[[], T],
    attempts: int = 5,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """Call `operation()`, retrying it on a transient failure; returns its result.

    Retries on 408, 429, 502, 503, 504 and on network failures, backing off 250 ms doubling to
    2 s, at most `attempts` calls. A rate limit that names its wait (429 `rate_limited` with
    `retry_after_ms`) is waited out exactly (plus 5 ms) and does not use up an attempt, up to 30 s
    of such waits in all. A server asking to wait more than 5 s gets its error raised at once.
    Never use it to retry conflicts or refusals: they are raised as they are. `operation` must
    resend the same request with the same idempotency key. `sleep` takes seconds.
    """
    if isinstance(attempts, bool) or not isinstance(attempts, int) or not 1 <= attempts <= 10:
        raise ValueError("Retry attempts must be an integer from 1 to 10")
    rate_limit_waited = 0.0
    attempt = 0
    while True:
        try:
            return operation()
        except (ApiError, NetworkError, ConnectionError, TimeoutError) as error:
            if isinstance(error, ApiError) and error.status not in RETRY_STATUSES:
                raise
            requested = error.retry_after_ms if isinstance(error, ApiError) else None
            if requested is not None and requested > LONGEST_SERVER_WAIT_MS:
                raise
            if (
                isinstance(error, ApiError)
                and error.status == 429
                and error.code == "rate_limited"
                and requested is not None
            ):
                wait = requested + RATE_LIMIT_MARGIN_MS
                if rate_limit_waited + wait > RATE_LIMIT_WAIT_CAP_MS:
                    raise
                rate_limit_waited += wait
                sleep(wait / 1000)
                continue
            attempt += 1
            if attempt >= attempts:
                raise
            sleep(backoff_ms(attempt, requested) / 1000)


__all__ = ["RETRY_STATUSES", "backoff_ms", "retry_memory"]
