// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! The live panel event stream (`/dashboard-ws`): hints that something changed.
//!
//! An event is a hint to read again with your own credential, never content. The stream
//! reconnects on its own (1 s doubling to 15 s); each (re)connection starts with a snapshot, so
//! `on_snapshot` is where to reread everything.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tungstenite::Message;
use tungstenite::stream::MaybeTlsStream;

/// What changed. Read the named resource again; the event carries no content.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PanelChangeEvent {
    /// `note_created`, `task_updated`, `resource_changed`, `canvas_node_created`, ...
    #[serde(rename = "type")]
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_id: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canvas_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
}

/// The wait before reconnect attempt `attempt` (0-based): 1 s doubling to 15 s.
pub fn panel_reconnect_delay(attempt: u32) -> Duration {
    Duration::from_millis((1000u64 << attempt.min(8)).min(15_000))
}

/// What one stream message means: `Some(None)` a snapshot, `Some(Some(event))` an event.
pub fn read_panel_message(text: &str) -> Option<Option<PanelChangeEvent>> {
    let message: Value = serde_json::from_str(text).ok()?;
    match message.get("type").and_then(Value::as_str) {
        Some("snapshot") => Some(None),
        Some("event") => {
            let data = message.get("data")?;
            data.get("type")?.as_str()?;
            // A field of an unexpected type drops only itself, never the hint.
            let mut event: PanelChangeEvent =
                serde_json::from_value(data.clone()).unwrap_or_default();
            if event.r#type.is_empty() {
                event.r#type = data["type"].as_str().unwrap_or("").to_string();
            }
            Some(Some(event))
        }
        _ => None,
    }
}

/// A running watch. `stop()` (or dropping it) ends it.
pub struct PanelWatch {
    stopped: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl PanelWatch {
    /// Stop watching and wait for the stream's thread to end.
    pub fn stop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take()
            && thread.thread().id() != thread::current().id()
        {
            let _ = thread.join(); // a panicking callback already ended it
        }
    }
}

impl Drop for PanelWatch {
    fn drop(&mut self) {
        self.stop();
    }
}

fn dashboard_url(http_url: &str, token: &str) -> String {
    let base = http_url.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else {
        format!("ws://{}", base.strip_prefix("http://").unwrap_or(base))
    };
    let mut url = format!("{ws}/dashboard-ws");
    if !token.is_empty() {
        url.push_str("?token=");
        for byte in token.bytes() {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                url.push(byte as char);
            } else {
                url.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    url
}

/// Watch `/dashboard-ws` on `http_url`, signed with `token()` (read on every connection).
pub fn watch_changes(
    http_url: &str,
    token: impl Fn() -> String + Send + 'static,
    on_event: impl Fn(&PanelChangeEvent) + Send + 'static,
    on_snapshot: impl Fn() + Send + 'static,
) -> PanelWatch {
    let stopped = Arc::new(AtomicBool::new(false));
    let flag = stopped.clone();
    let http_url = http_url.to_string();
    let thread = thread::Builder::new()
        .name("marina-panels".into())
        .spawn(move || {
            let mut attempts = 0u32;
            while !flag.load(Ordering::SeqCst) {
                if let Ok((mut socket, _)) =
                    tungstenite::connect(dashboard_url(&http_url, &token()))
                {
                    let tcp: Option<&TcpStream> = match socket.get_ref() {
                        MaybeTlsStream::Plain(s) => Some(s),
                        MaybeTlsStream::Rustls(s) => Some(&s.sock),
                        _ => None,
                    };
                    if tcp.is_some_and(|t| {
                        t.set_read_timeout(Some(Duration::from_millis(50))).is_ok()
                    }) {
                        loop {
                            if flag.load(Ordering::SeqCst) {
                                let _ = socket.close(None); // best effort
                                let _ = socket.flush();
                                return;
                            }
                            match socket.read() {
                                Ok(Message::Text(text)) => {
                                    match read_panel_message(text.as_str()) {
                                        Some(None) => {
                                            attempts = 0;
                                            on_snapshot();
                                        }
                                        Some(Some(event)) => on_event(&event),
                                        None => {}
                                    }
                                }
                                Ok(Message::Close(_)) => break,
                                Ok(_) => {}
                                Err(tungstenite::Error::Io(e))
                                    if matches!(
                                        e.kind(),
                                        ErrorKind::WouldBlock | ErrorKind::TimedOut
                                    ) => {}
                                Err(_) => break,
                            }
                        }
                    }
                }
                let deadline = Instant::now() + panel_reconnect_delay(attempts);
                attempts = attempts.saturating_add(1);
                while Instant::now() < deadline && !flag.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(20));
                }
            }
        })
        .ok();
    PanelWatch { stopped, thread }
}
