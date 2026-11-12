// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! The WebSocket conversation: log in, run commands, hear what the server sends.
//!
//! One SDK thread owns the socket; frames reach the SDK's own waiters there, in order. Your
//! listeners run on a second SDK thread, in order, and may run commands.
//!
//! When the socket drops, the SDK resumes the session on a new one with its newest token
//! (backoff from 3 s doubling to 30 s, at most 10 attempts). A command sent meanwhile fails at
//! once with [`Error::ConnectionLost`]; retry it. Only [`Connection::close`] ends the session.

use crate::error::{Error, Result};
use crate::wire::{Frame, Kind, classify, data_of, text_of};
use serde_json::{Map, Value, json};
use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

/// Seconds between keepalive pings (the server drops a socket silent for 255 s).
const PING_EVERY: Duration = Duration::from_secs(30);
/// How often the socket thread looks for frames to send while it waits to read.
const POLL: Duration = Duration::from_millis(25);
/// The first wait before resuming a dropped session; it doubles each attempt.
pub const RECONNECT_DELAY: Duration = Duration::from_secs(3);
/// The longest wait between attempts.
pub const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);
/// Attempts before the SDK gives up and closes the connection.
pub const MAX_RECONNECT_ATTEMPTS: u32 = 10;

/// The wait before reconnect attempt `attempt` (0-based): 3 s, 6 s, 12 s, 24 s, then 30 s.
pub fn reconnect_delay(attempt: u32) -> Duration {
    RECONNECT_DELAY
        .saturating_mul(2u32.saturating_pow(attempt.min(16)))
        .min(MAX_RECONNECT_DELAY)
}

/// Who you are on this connection. `token` is the newest; each token works once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub entity_id: String,
    pub name: String,
    pub token: String,
    /// The server takes `/command` as a world command even in Code Mode (`slash-v1`).
    pub world_command_grammar: bool,
}

/// A command's output frames, in order, once the server says it is done.
#[derive(Debug, Clone, Default)]
pub struct CommandResult {
    pub frames: Vec<Frame>,
}

impl CommandResult {
    /// Everything it said for people, one frame per line (may carry ANSI colour codes).
    pub fn text(&self) -> String {
        self.frames
            .iter()
            .map(text_of)
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// {WebSocket URL, HTTP base URL} of one server, from either form.
pub fn endpoints(url: &str) -> Result<(String, String)> {
    let trimmed = url.trim_end_matches('/');
    let (scheme, rest) = trimmed
        .split_once("://")
        .ok_or_else(|| Error::Invalid(format!("Not a Marina server URL: {url}")))?;
    let secure = match scheme {
        "ws" | "http" => false,
        "wss" | "https" => true,
        _ => return Err(Error::Invalid(format!("Not a Marina server URL: {url}"))),
    };
    let authority = rest.split('/').next().unwrap_or("");
    if authority.contains('@') || rest.contains('?') || rest.contains('#') || authority.is_empty() {
        return Err(Error::Invalid(
            "A server URL carries no credentials, query or fragment.".into(),
        ));
    }
    let base = rest.strip_suffix("/ws").unwrap_or(rest);
    Ok((
        format!("{}://{base}/ws", if secure { "wss" } else { "ws" }),
        format!("{}://{base}", if secure { "https" } else { "http" }),
    ))
}

type Callback = Arc<dyn Fn(&Frame) + Send + Sync>;
type CloseCallback = Arc<dyn Fn() + Send + Sync>;
type SessionCallback = Arc<dyn Fn(&Session) + Send + Sync>;

enum Outgoing {
    Text(String),
    Close,
}

struct Inner {
    out: Mutex<Option<Sender<Outgoing>>>,
    waiters: Mutex<Vec<(u64, Callback)>>,
    listeners: Mutex<Vec<(u64, Callback)>>,
    /// Final close (or reconnecting gave up).
    on_close: Mutex<Vec<(u64, CloseCallback)>>,
    /// Every lost socket, and the final close.
    on_disconnect: Mutex<Vec<(u64, CloseCallback)>>,
    on_reconnect: Mutex<Vec<(u64, SessionCallback)>>,
    events: Mutex<Option<Sender<Frame>>>,
    session: Mutex<Option<Session>>,
    closed: AtomicBool,
    /// `close()` was called: never reconnect.
    closing: AtomicBool,
    connected: AtomicBool,
    reconnecting: AtomicBool,
    auto_reconnect: AtomicBool,
    dispatching: AtomicBool,
    /// Which socket is current; a late end of an older one changes nothing.
    generation: AtomicU64,
    next_id: AtomicU64,
}

impl Inner {
    fn id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    fn deliver(&self, frame: Frame) {
        if classify(&frame) == Kind::Session {
            let data = data_of(&frame);
            let mut session = self.session.lock().unwrap();
            let previous_name = session.as_ref().map(|s| s.name.clone()).unwrap_or_default();
            *session = Some(Session {
                entity_id: data
                    .get("entityId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                name: data
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or(previous_name),
                token: data
                    .get("token")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                world_command_grammar: data.get("worldCommandProtocol").and_then(Value::as_str)
                    == Some("slash-v1"),
            });
        }
        let waiters: Vec<Callback> = self
            .waiters
            .lock()
            .unwrap()
            .iter()
            .map(|(_, w)| w.clone())
            .collect();
        for waiter in waiters {
            waiter(&frame);
        }
        let data = data_of(&frame);
        if data.contains_key("command_result") || data.contains_key("capabilities") {
            return;
        }
        if let Some(events) = self.events.lock().unwrap().as_ref() {
            let _ = events.send(frame); // the dispatcher is gone only after close
        }
    }

    fn finish(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.connected.store(false, Ordering::SeqCst);
        self.out.lock().unwrap().take();
        self.events.lock().unwrap().take();
        fire(&self.on_disconnect);
        fire(&self.on_close);
    }
}

fn fire(callbacks: &Mutex<Vec<(u64, CloseCallback)>>) {
    let callbacks: Vec<_> = callbacks
        .lock()
        .unwrap()
        .iter()
        .map(|(_, c)| c.clone())
        .collect();
    for callback in callbacks {
        callback();
    }
}

/// One WebSocket session with a Marina server. Cloning gives another handle to the same session.
#[derive(Clone)]
pub struct Connection {
    inner: Arc<Inner>,
    ws_url: String,
    http_url: String,
    principal: String,
    model: Option<String>,
    /// How long a command may take before `command` gives up (default 120 s).
    pub command_timeout: Duration,
    /// How long to wait for the server to answer a login (default 30 s).
    pub connect_timeout: Duration,
}

impl Connection {
    /// A connection to `url` (`ws://`, `wss://`, `http://` or `https://`). Nothing is sent yet.
    pub fn new(url: &str, principal: &str, model: Option<&str>) -> Result<Connection> {
        let (ws_url, http_url) = endpoints(url)?;
        Ok(Connection {
            inner: Arc::new(Inner {
                out: Mutex::new(None),
                waiters: Mutex::new(Vec::new()),
                listeners: Mutex::new(Vec::new()),
                on_close: Mutex::new(Vec::new()),
                on_disconnect: Mutex::new(Vec::new()),
                on_reconnect: Mutex::new(Vec::new()),
                events: Mutex::new(None),
                session: Mutex::new(None),
                closed: AtomicBool::new(false),
                closing: AtomicBool::new(false),
                connected: AtomicBool::new(false),
                reconnecting: AtomicBool::new(false),
                auto_reconnect: AtomicBool::new(true),
                dispatching: AtomicBool::new(false),
                generation: AtomicU64::new(0),
                next_id: AtomicU64::new(1),
            }),
            ws_url,
            http_url,
            principal: principal.to_string(),
            model: model.map(str::to_string),
            command_timeout: Duration::from_secs(120),
            connect_timeout: Duration::from_secs(30),
        })
    }

    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    pub fn http_url(&self) -> &str {
        &self.http_url
    }

    /// The current session, or `None` before login.
    pub fn session(&self) -> Option<Session> {
        self.inner.session.lock().unwrap().clone()
    }

    /// Closed for good: by `close()`, or reconnecting gave up.
    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// A socket is open (false while the SDK is reconnecting).
    pub fn is_connected(&self) -> bool {
        self.inner.connected.load(Ordering::SeqCst)
    }

    /// Resume a dropped session on its own (default true). Turn it off before logging in to
    /// handle drops yourself.
    pub fn set_auto_reconnect(&self, on: bool) {
        self.inner.auto_reconnect.store(on, Ordering::SeqCst);
    }

    /// Called with the new session each time the SDK resumes a dropped one. Returns an id for
    /// [`Connection::off_reconnect`]. Runs on an SDK thread; it may run commands.
    pub fn on_reconnect(&self, callback: impl Fn(&Session) + Send + Sync + 'static) -> u64 {
        let id = self.inner.id();
        self.inner
            .on_reconnect
            .lock()
            .unwrap()
            .push((id, Arc::new(callback)));
        id
    }

    pub fn off_reconnect(&self, id: u64) {
        self.inner
            .on_reconnect
            .lock()
            .unwrap()
            .retain(|(i, _)| *i != id);
    }

    // ─── Opening ───────────────────────────────────────────────────────────

    fn open(&self) -> Result<()> {
        if self.is_closed() {
            return Err(Error::ConnectionLost("The connection is closed.".into()));
        }
        if self.inner.out.lock().unwrap().is_some() {
            return Ok(());
        }
        let (mut socket, _) = tungstenite::connect(self.ws_url.as_str())
            .map_err(|e| Error::ConnectionLost(format!("Could not reach {}: {e}", self.ws_url)))?;
        let tcp: &TcpStream = match socket.get_ref() {
            MaybeTlsStream::Plain(s) => s,
            MaybeTlsStream::Rustls(s) => &s.sock,
            _ => return Err(Error::ConnectionLost("Unsupported stream".into())),
        };
        tcp.set_read_timeout(Some(POLL))
            .map_err(|e| Error::ConnectionLost(format!("Could not configure the socket: {e}")))?;
        if !self.inner.dispatching.swap(true, Ordering::SeqCst) {
            // One listener thread for the connection's whole life, across sockets.
            let (event_tx, event_rx) = mpsc::channel::<Frame>();
            *self.inner.events.lock().unwrap() = Some(event_tx);
            let inner = self.inner.clone();
            thread::Builder::new()
                .name("marina-events".into())
                .spawn(move || dispatch(event_rx, &inner))
                .map_err(|e| Error::Other(e.to_string()))?;
        }
        let (out_tx, out_rx) = mpsc::channel::<Outgoing>();
        let generation = {
            let mut out = self.inner.out.lock().unwrap();
            if self.is_closed() {
                return Err(Error::ConnectionLost("The connection is closed.".into()));
            }
            *out = Some(out_tx);
            let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
            self.inner.connected.store(true, Ordering::SeqCst);
            generation
        };
        let connection = self.clone();
        thread::Builder::new()
            .name("marina-socket".into())
            .spawn(move || {
                pump(&mut socket, &out_rx, &connection.inner);
                connection.socket_ended(generation);
            })
            .map_err(|e| Error::Other(e.to_string()))?;
        Ok(())
    }

    /// A socket's thread ended: tell in-flight waiters, then resume the session, or finish.
    fn socket_ended(&self, generation: u64) {
        let inner = &self.inner;
        {
            let mut out = inner.out.lock().unwrap();
            if inner.generation.load(Ordering::SeqCst) != generation {
                return; // an older socket: a newer one is already current
            }
            out.take();
            inner.connected.store(false, Ordering::SeqCst);
        }
        fire(&inner.on_disconnect);
        if inner.closing.load(Ordering::SeqCst)
            || !inner.auto_reconnect.load(Ordering::SeqCst)
            || self.session().is_none()
        {
            inner.finish();
            return;
        }
        // An attempt in progress handles this socket's end itself.
        if inner
            .reconnecting
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.reconnect_loop();
        }
    }

    /// Resume the session with its newest token, with backoff; give up (and finish) after
    /// [`MAX_RECONNECT_ATTEMPTS`].
    fn reconnect_loop(&self) {
        let inner = &self.inner;
        let mut attempt = 0;
        loop {
            if attempt >= MAX_RECONNECT_ATTEMPTS || !self.pause(reconnect_delay(attempt)) {
                inner.reconnecting.store(false, Ordering::SeqCst);
                inner.finish();
                return;
            }
            attempt += 1;
            let Some(token) = self.session().map(|s| s.token) else {
                continue;
            };
            match self
                .open()
                .and_then(|_| self.authenticate(json!({ "type": "auth", "token": token })))
            {
                Ok(session) => {
                    inner.reconnecting.store(false, Ordering::SeqCst);
                    // Dropped again before the flag went down: nobody else saw it, go on.
                    if !self.is_connected()
                        && inner
                            .reconnecting
                            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                    {
                        continue;
                    }
                    let callbacks: Vec<SessionCallback> = inner
                        .on_reconnect
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|(_, c)| c.clone())
                        .collect();
                    for callback in callbacks {
                        let call = std::panic::AssertUnwindSafe(|| callback(&session));
                        if std::panic::catch_unwind(call).is_err() {
                            eprintln!("marina: a reconnect callback panicked");
                        }
                    }
                    return;
                }
                Err(_) => {
                    // Refused or lost: drop this socket (its end changes nothing) and wait.
                    if let Some(out) = inner.out.lock().unwrap().take() {
                        inner.connected.store(false, Ordering::SeqCst);
                        let _ = out.send(Outgoing::Close); // its thread may already be gone
                    }
                }
            }
        }
    }

    /// Sleep `wait`, waking early on `close()`. False when closing.
    fn pause(&self, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        while Instant::now() < deadline {
            if self.inner.closing.load(Ordering::SeqCst) || self.is_closed() {
                return false;
            }
            thread::sleep(
                Duration::from_millis(20).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
        !(self.inner.closing.load(Ordering::SeqCst) || self.is_closed())
    }

    /// Enter the world under a name (2-20 letters or digits).
    pub fn login(&self, name: &str) -> Result<Session> {
        self.open()?;
        self.authenticate(json!({ "type": "login", "name": name }))
    }

    /// Resume a dropped session with its token, within 60 s of the drop.
    pub fn resume(&self, token: &str) -> Result<Session> {
        self.open()?;
        self.authenticate(json!({ "type": "auth", "token": token }))
    }

    fn authenticate(&self, mut frame: Value) -> Result<Session> {
        frame["principal"] = Value::String(self.principal.clone());
        if let Some(model) = &self.model {
            frame["model"] = Value::String(model.clone());
        }
        let (tx, rx) = mpsc::channel::<std::result::Result<(), String>>();
        let lost = tx.clone();
        let waiter = self.add_waiter(move |f| match classify(f) {
            Kind::Session => {
                let _ = tx.send(Ok(()));
            }
            Kind::AuthError | Kind::Error => {
                let text = text_of(f);
                let _ = tx.send(Err(if text.is_empty() {
                    "Login refused".into()
                } else {
                    text
                }));
            }
            _ => {}
        });
        let closer = self.add_disconnect(move || {
            let _ = lost.send(Err("\u{0}lost".into()));
        });
        let outcome = self.send(&frame).and_then(|_| {
            rx.recv_timeout(self.connect_timeout).map_err(|_| {
                Error::ConnectionLost("The server did not answer the login in time.".into())
            })
        });
        self.remove_waiter(waiter);
        self.remove_disconnect(closer);
        match outcome? {
            Ok(()) => self
                .session()
                .ok_or_else(|| Error::ConnectionLost("No session".into())),
            Err(m) if m == "\u{0}lost" => Err(Error::ConnectionLost(
                "The connection closed during login.".into(),
            )),
            Err(m) => Err(Error::LoginRefused(m)),
        }
    }

    // ─── Commands ──────────────────────────────────────────────────────────

    /// Run one world command and wait until the server says it is done.
    ///
    /// It is always a world command, never a task for a coder in Code Mode. Returns
    /// `Error::Command` when the server refuses or fails it.
    pub fn command(&self, text: &str) -> Result<CommandResult> {
        self.command_with(text, None, true)
    }

    /// Run one command. `timeout`: `None` for the connection's; `world`: false sends it as typed.
    pub fn command_with(
        &self,
        text: &str,
        timeout: Option<Duration>,
        world: bool,
    ) -> Result<CommandResult> {
        let session = self
            .session()
            .ok_or_else(|| Error::ConnectionLost("Not logged in.".into()))?;
        let mut line = text.trim().to_string();
        if world && session.world_command_grammar && !line.starts_with('/') {
            line.insert(0, '/');
        }
        let request_id = new_id();
        let frames: Arc<Mutex<Vec<Frame>>> = Arc::default();
        let (tx, rx) = mpsc::channel::<Option<Map<String, Value>>>();
        let lost = tx.clone();
        let (id, collected) = (request_id.clone(), frames.clone());
        let waiter = self.add_waiter(move |f| {
            if f.get("command_request_id").and_then(Value::as_str) == Some(id.as_str()) {
                collected.lock().unwrap().push(f.clone());
            }
            if let Some(result) = data_of(f).get("command_result").and_then(Value::as_object)
                && result.get("request_id").and_then(Value::as_str) == Some(id.as_str())
            {
                let _ = tx.send(Some(result.clone()));
            }
        });
        let closer = self.add_disconnect(move || {
            let _ = lost.send(None);
        });
        let sent =
            self.send(&json!({ "type": "command", "command": line, "request_id": request_id }));
        let outcome = sent.map(|_| rx.recv_timeout(timeout.unwrap_or(self.command_timeout)));
        self.remove_waiter(waiter);
        self.remove_disconnect(closer);
        let frames = frames.lock().unwrap().clone();
        let fail = |reason: &str| Error::Command {
            reason: reason.into(),
            frames: frames.clone(),
        };
        match outcome? {
            Err(_) => Err(fail(
                "Command completion timed out; execution outcome is unknown. Inspect state before retrying.",
            )),
            Ok(None) => Err(fail(
                "Disconnected before command completion; execution outcome is unknown.",
            )),
            Ok(Some(result)) if result.get("ok") == Some(&Value::Bool(true)) => {
                Ok(CommandResult { frames })
            }
            Ok(Some(result)) => {
                let reason = result
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Command failed")
                    .to_string();
                Err(Error::Command { reason, frames })
            }
        }
    }

    /// Every command this session may run, with typed forms (`marina.capabilities.v1`).
    pub fn capabilities(&self) -> Result<Map<String, Value>> {
        let request_id = new_id();
        let (tx, rx) = mpsc::channel::<Map<String, Value>>();
        let id = request_id.clone();
        let waiter = self.add_waiter(move |f| {
            if let Some(reply) = data_of(f).get("capabilities").and_then(Value::as_object)
                && reply.get("request_id").and_then(Value::as_str) == Some(id.as_str())
            {
                let _ = tx.send(reply.clone());
            }
        });
        let outcome = self
            .send(&json!({ "type": "capabilities", "request_id": request_id }))
            .and_then(|_| {
                rx.recv_timeout(Duration::from_secs(10))
                    .map_err(|_| Error::Other("Capability discovery timed out.".into()))
            });
        self.remove_waiter(waiter);
        let reply = outcome?;
        if let Some(error) = reply.get("error") {
            return Err(Error::Other(error.to_string()));
        }
        Ok(reply)
    }

    // ─── Listening ─────────────────────────────────────────────────────────

    /// Call `listener` with every frame the server sends you (command replies excepted).
    /// Returns an id for [`Connection::off_frame`].
    pub fn on_frame(&self, listener: impl Fn(&Frame) + Send + Sync + 'static) -> u64 {
        let id = self.inner.id();
        self.inner
            .listeners
            .lock()
            .unwrap()
            .push((id, Arc::new(listener)));
        id
    }

    /// Stop a listener.
    pub fn off_frame(&self, id: u64) {
        self.inner
            .listeners
            .lock()
            .unwrap()
            .retain(|(i, _)| *i != id);
    }

    /// Called on every lost socket (the SDK may then reconnect) and on the final close.
    pub fn add_disconnect(&self, callback: impl Fn() + Send + Sync + 'static) -> u64 {
        let id = self.inner.id();
        self.inner
            .on_disconnect
            .lock()
            .unwrap()
            .push((id, Arc::new(callback)));
        id
    }

    pub fn remove_disconnect(&self, id: u64) {
        self.inner
            .on_disconnect
            .lock()
            .unwrap()
            .retain(|(i, _)| *i != id);
    }

    /// Called once when the connection closes for good (`close()`, or reconnecting gave up).
    /// Returns an id for [`Connection::remove_close`].
    pub fn add_close(&self, callback: impl Fn() + Send + Sync + 'static) -> u64 {
        let id = self.inner.id();
        self.inner
            .on_close
            .lock()
            .unwrap()
            .push((id, Arc::new(callback)));
        id
    }

    pub fn remove_close(&self, id: u64) {
        self.inner
            .on_close
            .lock()
            .unwrap()
            .retain(|(i, _)| *i != id);
    }

    /// SDK waiters run on the socket thread, in order, before listeners: keep them quick.
    pub(crate) fn add_waiter(&self, waiter: impl Fn(&Frame) + Send + Sync + 'static) -> u64 {
        let id = self.inner.id();
        self.inner
            .waiters
            .lock()
            .unwrap()
            .push((id, Arc::new(waiter)));
        id
    }

    pub(crate) fn remove_waiter(&self, id: u64) {
        self.inner.waiters.lock().unwrap().retain(|(i, _)| *i != id);
    }

    /// Close the socket (the server sees a normal close). It never reconnects after this.
    pub fn close(&self) {
        self.inner.closing.store(true, Ordering::SeqCst);
        match self.inner.out.lock().unwrap().as_ref() {
            Some(out) => {
                let _ = out.send(Outgoing::Close); // the socket thread may already be gone
            }
            None => self.inner.finish(),
        }
        // Wait briefly for the socket thread to finish the close, then finish regardless.
        let deadline = Instant::now() + Duration::from_secs(2);
        while !self.is_closed() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        self.inner.finish();
    }

    fn send(&self, frame: &Value) -> Result<()> {
        let lost = || {
            Error::ConnectionLost(if self.is_closed() {
                "The connection is closed.".into()
            } else {
                "Connection lost; reconnecting. Retry the command.".into()
            })
        };
        let out = self.inner.out.lock().unwrap();
        match out.as_ref() {
            Some(tx) => tx
                .send(Outgoing::Text(frame.to_string()))
                .map_err(|_| lost()),
            None => Err(lost()),
        }
    }
}

fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "rs-{nanos:x}-{:x}-{:x}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// The socket thread: read (with a short timeout), then send what is queued, until closed.
fn pump(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    out: &Receiver<Outgoing>,
    inner: &Inner,
) {
    let mut last_send = Instant::now();
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                if let Ok(Value::Object(frame)) = serde_json::from_str::<Value>(text.as_str()) {
                    inner.deliver(frame);
                }
            }
            Ok(Message::Close(_)) => return,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => return,
        }
        loop {
            match out.try_recv() {
                Ok(Outgoing::Text(text)) => {
                    if socket.send(Message::text(text)).is_err() {
                        return;
                    }
                    last_send = Instant::now();
                }
                Ok(Outgoing::Close) | Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = socket.close(None); // best effort; the server may already be gone
                    let _ = socket.flush();
                    return;
                }
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }
        if last_send.elapsed() >= PING_EVERY {
            if socket.send(Message::text(r#"{"type":"ping"}"#)).is_err() {
                return;
            }
            last_send = Instant::now();
        }
    }
}

/// The listener thread: every frame, to every listener, in order.
fn dispatch(events: Receiver<Frame>, inner: &Inner) {
    while let Ok(frame) = events.recv() {
        let listeners: Vec<Callback> = inner
            .listeners
            .lock()
            .unwrap()
            .iter()
            .map(|(_, l)| l.clone())
            .collect();
        for listener in listeners {
            let call = std::panic::AssertUnwindSafe(|| listener(&frame));
            if std::panic::catch_unwind(call).is_err() {
                eprintln!("marina: a frame listener panicked; delivery continues");
            }
        }
    }
}
