// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! Every error the SDK returns.

use crate::wire::{Frame, text_of};
use std::fmt;

/// What went wrong. Branch on the variant; the messages are for people.
#[derive(Debug, Clone)]
pub enum Error {
    /// The connection closed, or could not be opened.
    ConnectionLost(String),
    /// The server refused a login or a session token.
    LoginRefused(String),
    /// The server refused or failed a command. `frames` holds what it sent first.
    Command { reason: String, frames: Vec<Frame> },
    /// An HTTP API refused or failed a request. Branch on `code`.
    Api {
        status: u16,
        code: String,
        message: String,
        retry_after_ms: Option<u64>,
    },
    /// A coding run did not finish in time; it was stopped.
    CodingTimeout(String),
    /// A call the SDK refused before sending anything (a bad argument).
    Invalid(String),
    /// Anything else: a process that would not start, an unreadable reply.
    Other(String),
}

/// `Result` with the SDK's error.
pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::ConnectionLost(m) | Error::LoginRefused(m) | Error::CodingTimeout(m) => {
                f.write_str(m)
            }
            Error::Invalid(m) | Error::Other(m) => f.write_str(m),
            Error::Command { reason, frames } => f.write_str(&describe(reason, frames)),
            Error::Api {
                status,
                code,
                message,
                ..
            } => write!(f, "{status} {code}: {message}"),
        }
    }
}

impl std::error::Error for Error {}

/// The refusal once, as the headline, then any other output.
fn describe(reason: &str, frames: &[Frame]) -> String {
    let head = reason.trim();
    let texts: Vec<String> = frames
        .iter()
        .map(text_of)
        .filter(|t| !t.is_empty())
        .collect();
    let echo = texts
        .iter()
        .position(|t| !head.is_empty() && t.trim().starts_with(head));
    let rest: Vec<&String> = texts
        .iter()
        .enumerate()
        .filter(|(i, t)| Some(*i) != echo && t.trim() != head)
        .map(|(_, t)| t)
        .collect();
    let headline = echo
        .map(|i| texts[i].trim().to_string())
        .unwrap_or_else(|| reason.to_string());
    if rest.is_empty() {
        headline
    } else {
        format!(
            "{headline}\n\nPartial command output (completed actions are not rolled back):\n{}",
            rest.iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join("\n\n")
        )
    }
}
