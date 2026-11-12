// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! Retrying a memory call: the same request (and idempotency key) again, the TypeScript SDK's
//! rules exactly.
//!
//! - Retried: HTTP 408, 429, 502, 503 and 504, and transport failures.
//! - A named rate limit (`429 rate_limited` with `retry_after_ms`) is waited out exactly (plus
//!   5 ms) and does not use up an attempt, up to 30 s of such waits in all.
//! - Other failures back off 250 ms doubling to 2 s (or the server's wait, if longer).
//! - A server wait over 5 s is handed back to the caller as the error.
//!
//! ```no_run
//! # fn demo(memory: &marina_sdk::models::MemoryApi, space: &str) -> marina_sdk::Result<()> {
//! use marina_sdk::models::MemoryRecordInput;
//! use marina_sdk::retry_memory;
//! let note = MemoryRecordInput { content: "Deploys run from main".into(), ..Default::default() };
//! // One key for every try: a retry can never write twice.
//! let receipt = retry_memory(|| memory.remember(space, &note, Some("deploy-note-1")), 5, std::thread::sleep)?;
//! # Ok(()) }
//! ```

use crate::error::{Error, Result};
use std::time::Duration;

/// The most time spent waiting out named rate limits before giving up.
pub const RATE_LIMIT_WAIT_CAP: Duration = Duration::from_secs(30);
/// Timers may fire a little early: wait slightly past a named rate-limit wait.
pub const RATE_LIMIT_MARGIN: Duration = Duration::from_millis(5);
/// A server wait longer than this is the caller's to schedule.
pub const LONGEST_SERVER_WAIT: Duration = Duration::from_secs(5);

/// The backoff before retry `attempt` (1-based) of an ordinary failure: 250 ms doubling to 2 s.
pub fn memory_backoff(attempt: u32) -> Duration {
    let ms = 250u64.saturating_mul(1u64 << attempt.saturating_sub(1).min(16));
    Duration::from_millis(ms.min(2000))
}

/// Run `operation` until it succeeds or the rules above stop it. `attempts` (1 to 10, the
/// TypeScript default is 5) counts tries, named rate-limit waits aside. `sleep` waits; pass
/// `std::thread::sleep`, or a fake in tests.
pub fn retry_memory<T>(
    mut operation: impl FnMut() -> Result<T>,
    attempts: u32,
    mut sleep: impl FnMut(Duration),
) -> Result<T> {
    if !(1..=10).contains(&attempts) {
        return Err(Error::Invalid(
            "Retry attempts must be an integer from 1 to 10".into(),
        ));
    }
    let mut rate_limit_waited = Duration::ZERO;
    let mut attempt = 0;
    loop {
        let error = match operation() {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };
        let (retryable, requested, named) = match &error {
            Error::Api {
                status,
                code,
                retry_after_ms,
                ..
            } => (
                matches!(status, 408 | 429 | 502 | 503 | 504),
                retry_after_ms.map(Duration::from_millis),
                *status == 429 && code == "rate_limited" && retry_after_ms.is_some(),
            ),
            Error::Transport(_) => (true, None, false),
            _ => (false, None, false),
        };
        if !retryable {
            return Err(error);
        }
        // Do not retry sooner than a server's longer delay; hand control back.
        if requested.is_some_and(|r| r > LONGEST_SERVER_WAIT) {
            return Err(error);
        }
        if named {
            let wait = requested.unwrap_or_default() + RATE_LIMIT_MARGIN;
            if rate_limit_waited + wait > RATE_LIMIT_WAIT_CAP {
                return Err(error);
            }
            rate_limit_waited += wait;
            sleep(wait);
            continue;
        }
        attempt += 1;
        if attempt >= attempts {
            return Err(error);
        }
        sleep(requested.unwrap_or_default().max(memory_backoff(attempt)));
    }
}
