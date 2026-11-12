// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! Talking to other participants: `tell`, `say`, asking and waiting for the answer
//! (`tell_and_await`), and waiting for a question (`wait_for_tell`).
//!
//! The rules match the TypeScript SDK's `tellAndAwait`: the question carries a correlation tag
//! ` [re:<id>]`; a reply echoing it wins at once; an untagged reply is held for a short grace in
//! case a tagged one follows, then accepted; lifecycle notices ("I've spent my model-call
//! budget ...") are never an answer; a tell that predates the question is ignored.

use crate::client::Connection;
use crate::error::{Error, Result};
use crate::wire::{Frame, data_of};
use serde_json::Value;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Prefix of a `tell` that is a lifecycle notice, not a reply.
pub const TELL_NOTICE_PREFIX: &str = "[notice]";
/// How long an untagged reply is held for a tagged one to arrive.
pub const TELL_AWAIT_GRACE: Duration = Duration::from_millis(1500);

fn boundary_after(text: &str, end: usize) -> bool {
    // A regex `\b` after a word character: the next character is not a word character.
    text[end..]
        .chars()
        .next()
        .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'))
}

/// True when `text` is a known notice ("I paused", "budget spent") rather than a reply.
pub fn is_tell_notice(text: &str) -> bool {
    let t = text.trim_start();
    if t.len() >= TELL_NOTICE_PREFIX.len()
        && t.is_char_boundary(TELL_NOTICE_PREFIX.len())
        && t[..TELL_NOTICE_PREFIX.len()].eq_ignore_ascii_case(TELL_NOTICE_PREFIX)
    {
        return true;
    }
    let budget = "I've spent my model-call budget";
    if t.starts_with(budget) && boundary_after(t, budget.len()) {
        return true;
    }
    if let Some(rest) = t.strip_prefix("I've hit a ") {
        // `.+ and paused\b`: at least one character (no line break) before " and paused".
        let line = rest.split('\n').next().unwrap_or("");
        let needle = " and paused";
        let mut from = 1;
        while from <= line.len() {
            let Some(at) = line.get(from..).and_then(|s| s.find(needle)) else {
                break;
            };
            let end = from + at + needle.len();
            if boundary_after(line, end) {
                return true;
            }
            from += at + 1;
        }
    }
    if let Some(rest) = t.strip_prefix("I've hit ") {
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        let tail = "consecutive upstream errors";
        if digits > 0
            && rest[digits..].starts_with(' ')
            && rest[digits + 1..].starts_with(tail)
            && boundary_after(rest, digits + 1 + tail.len())
        {
            return true;
        }
    }
    false
}

/// The tag a correlated question carries: ` [re:<id>]`.
pub fn correlation_tag(id: &str) -> String {
    format!(" [re:{id}]")
}

/// True when `text` carries `re:<id>` (bracketed or bare).
pub fn has_correlation_tag(text: &str, id: &str) -> bool {
    text.contains(&format!("re:{id}"))
}

/// Remove every `[re:<id>]` / `re:<id>` (with the whitespace before it) and trim.
pub fn strip_correlation_tag(text: &str, id: &str) -> String {
    let needle = format!("re:{id}");
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(&needle) {
        let mut start = at;
        if rest[..start].ends_with('[') {
            start -= 1;
        }
        let kept = rest[..start].trim_end();
        out.push_str(kept);
        let mut end = at + needle.len();
        if rest[end..].starts_with(']') {
            end += 1;
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// A fresh six-character id (base 36) for a correlation tag.
pub fn new_correlation_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u128(now_ms() as u128);
    let bits = hasher.finish();
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    (0..6)
        .map(|i| ALPHABET[((bits >> (i * 8)) & 0xff) as usize % ALPHABET.len()] as char)
        .collect()
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// A tell to you: `(sender name, text)`. The echo of one you sent names no sender.
pub fn tell_of(frame: &Frame) -> Option<(String, String)> {
    if frame.get("tag").and_then(Value::as_str) != Some("tell") {
        return None;
    }
    let data = data_of(frame);
    let sender = data.get("senderName")?.as_str()?;
    Some((sender.to_string(), tell_text(data)))
}

fn tell_text(data: &serde_json::Map<String, Value>) -> String {
    let pick = |k: &str| match data.get(k) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Null) | None => None,
        Some(other) => Some(other.to_string()),
    };
    pick("message").or_else(|| pick("text")).unwrap_or_default()
}

/// How `tell_and_await` waits.
#[derive(Debug, Clone)]
pub struct TellAwaitOptions {
    /// Give up after this long (default 30 s). A held untagged reply is returned instead.
    pub timeout: Duration,
    /// Tag the question and prefer a reply that echoes the tag (default true).
    pub correlate: bool,
    /// Accept only a reply that echoes the tag (default false).
    pub strict_correlation: bool,
    /// How long an untagged reply is held for a tagged one (default 1.5 s).
    pub grace: Duration,
    /// Never take a notice as the answer (default true).
    pub ignore_notices: bool,
}

impl Default for TellAwaitOptions {
    fn default() -> Self {
        TellAwaitOptions {
            timeout: Duration::from_secs(30),
            correlate: true,
            strict_correlation: false,
            grace: TELL_AWAIT_GRACE,
            ignore_notices: true,
        }
    }
}

enum Reply {
    Tagged(String),
    Untagged(String),
}

impl Connection {
    /// Send a private message.
    pub fn tell(&self, target: &str, message: &str) -> Result<()> {
        self.command(&format!("tell {target} {message}"))
            .map(|_| ())
    }

    /// Say something to the room.
    pub fn say(&self, message: &str) -> Result<()> {
        self.command(&format!("say {message}")).map(|_| ())
    }

    /// Ask `target` and wait for its answer (the reply's text, correlation tag removed).
    pub fn tell_and_await(&self, target: &str, message: &str, timeout: Duration) -> Result<String> {
        self.tell_and_await_with(
            target,
            message,
            &TellAwaitOptions {
                timeout,
                ..Default::default()
            },
        )
    }

    /// `tell_and_await` with every option.
    pub fn tell_and_await_with(
        &self,
        target: &str,
        message: &str,
        options: &TellAwaitOptions,
    ) -> Result<String> {
        if self.session().is_none() {
            return Err(Error::ConnectionLost("Not logged in.".into()));
        }
        let correlate = options.strict_correlation || options.correlate;
        let id = correlate.then(new_correlation_id);
        let outgoing = match &id {
            Some(id) => format!("{message}{}", correlation_tag(id)),
            None => message.to_string(),
        };
        let target_key = target.to_lowercase();
        let sent_at = now_ms();
        let started = Instant::now();
        let (tx, rx) = mpsc::channel::<Reply>();
        let armed = Arc::new(Mutex::new(false));
        let (echo, tag, ignore_notices) = (outgoing.clone(), id.clone(), options.ignore_notices);
        let waiter = self.add_waiter(move |frame| {
            if frame.get("kind").and_then(Value::as_str) != Some("message")
                || frame.get("tag").and_then(Value::as_str) != Some("tell")
            {
                return;
            }
            let data = data_of(frame);
            let text = tell_text(data);
            let mut armed = armed.lock().unwrap();
            let Some(sender) = data.get("senderName").and_then(Value::as_str) else {
                // Our own `You tell <target>: ...` echo: every later tell is fresh.
                if !*armed && text.contains(&echo) {
                    *armed = true;
                }
                return;
            };
            if sender.to_lowercase() != target_key {
                return;
            }
            // Before the echo, a tell older than the question is a queued stale frame.
            let fresh = frame
                .get("timestamp")
                .and_then(Value::as_f64)
                .is_some_and(|t| t >= sent_at);
            if !*armed && !fresh {
                return;
            }
            if ignore_notices && is_tell_notice(&text) {
                return;
            }
            let reply = match &tag {
                Some(id) if !has_correlation_tag(&text, id) => Reply::Untagged(text),
                _ => Reply::Tagged(text),
            };
            let _ = tx.send(reply); // the asker may have stopped waiting
        });
        if let Err(e) = self.command(&format!("tell {target} {outgoing}")) {
            self.remove_waiter(waiter);
            return Err(e);
        }
        let deadline = started + options.timeout;
        let mut candidate: Option<String> = None;
        let mut grace_end: Option<Instant> = None;
        let outcome = loop {
            let until = grace_end.map_or(deadline, |g| g.min(deadline));
            match rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
                Ok(Reply::Tagged(text)) => break Ok(text),
                Ok(Reply::Untagged(text)) => {
                    if options.strict_correlation || candidate.is_some() {
                        continue;
                    }
                    candidate = Some(text);
                    grace_end = Some(Instant::now() + options.grace);
                }
                Err(_) => match candidate.take() {
                    Some(text) => break Ok(text),
                    None if Instant::now() >= deadline => {
                        break Err(Error::Timeout(format!(
                            "tell_and_await: no reply from \"{target}\" within {} ms",
                            options.timeout.as_millis()
                        )));
                    }
                    None => {}
                },
            }
        };
        self.remove_waiter(waiter);
        outcome.map(|text| match &id {
            Some(id) => strip_correlation_tag(&text, id),
            None => text,
        })
    }

    /// Wait for a tell to you, from `from` (any sender with `None`). Returns its text.
    pub fn wait_for_tell(&self, from: Option<&str>, timeout: Duration) -> Result<String> {
        let key = from.map(str::to_lowercase);
        let (tx, rx) = mpsc::channel::<String>();
        let waiter = self.add_waiter(move |frame| {
            if let Some((sender, text)) = tell_of(frame)
                && key.as_ref().is_none_or(|k| *k == sender.to_lowercase())
            {
                let _ = tx.send(text); // only the first is read
            }
        });
        let outcome = rx.recv_timeout(timeout);
        self.remove_waiter(waiter);
        outcome.map_err(|_| {
            Error::Timeout(match from {
                Some(f) => format!(
                    "wait_for_tell: no tell from \"{f}\" within {} ms",
                    timeout.as_millis()
                ),
                None => format!("wait_for_tell: no tell within {} ms", timeout.as_millis()),
            })
        })
    }

    // ─── Common commands ───────────────────────────────────────────────────

    /// Look at the room, or at something in it.
    pub fn look(&self, target: Option<&str>) -> Result<crate::client::CommandResult> {
        self.command(&match target {
            Some(t) => format!("look {t}"),
            None => "look".into(),
        })
    }

    /// Move in a direction (`north`, `out`, ...).
    pub fn go(&self, direction: &str) -> Result<crate::client::CommandResult> {
        self.command(direction)
    }

    /// Who is online.
    pub fn who(&self) -> Result<crate::client::CommandResult> {
        self.command("who")
    }

    /// Send a message to a channel.
    pub fn channel_send(&self, channel: &str, message: &str) -> Result<()> {
        self.command(&format!("channel send {channel} {message}"))
            .map(|_| ())
    }

    /// Save a note to your memory.
    pub fn note(&self, text: &str) -> Result<crate::client::CommandResult> {
        self.command(&format!("note {text}"))
    }

    /// Search your memory.
    pub fn recall(&self, query: &str) -> Result<crate::client::CommandResult> {
        self.command(&format!("recall {query}"))
    }

    /// The next useful thing to do.
    pub fn next(&self) -> Result<crate::client::CommandResult> {
        self.command("next")
    }

    /// A short brief of where you are and what is going on.
    pub fn brief(&self) -> Result<crate::client::CommandResult> {
        self.command("brief")
    }

    /// Help for every command, or for one.
    pub fn help(&self, command: Option<&str>) -> Result<crate::client::CommandResult> {
        self.command(&match command {
            Some(c) => format!("help {c}"),
            None => "help".into(),
        })
    }
}
