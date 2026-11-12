// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! Marina for Rust: run coding tasks, send commands and use the HTTP APIs from your code.
//!
//! ```no_run
//! use marina_sdk::{Marina, RunOptions, Verdict};
//!
//! # fn main() -> marina_sdk::Result<()> {
//! // A Marina for this folder: the same server and saved sessions `marina .` uses.
//! let marina = Marina::local("my-project")?;
//! let run = marina.code().run("Fix the failing test", RunOptions::default())?;
//! for step in run.steps() {
//!     println!("{}", step.label);
//! }
//! let result = run.result()?;
//! marina.code().review(&result.run_id, Verdict::Approve)?;
//! # Ok(()) }
//! ```
//!
//! The protocols are `marina.wire.v1` (WebSocket) and `marina.http.v1` (HTTP), in the Marina
//! repository's `protocol/` folder. Blocking API: the SDK runs its own threads.

pub mod agent;
pub mod client;
pub mod coding;
pub mod error;
pub mod forms;
pub mod http;
#[rustfmt::skip]
pub mod models;
#[rustfmt::skip]
pub mod operations;
pub mod panel_events;
pub mod retry;
pub mod wire;

pub use agent::{
    TELL_AWAIT_GRACE, TELL_NOTICE_PREFIX, TellAwaitOptions, correlation_tag, has_correlation_tag,
    is_tell_notice, strip_correlation_tag, tell_of,
};
pub use client::{
    CommandResult, Connection, MAX_RECONNECT_ATTEMPTS, MAX_RECONNECT_DELAY, RECONNECT_DELAY,
    Session, endpoints, reconnect_delay,
};
pub use coding::{
    Coding, CodingRun, RunOptions, Verdict, Verification, budget_argument, exec_answer,
};
pub use error::{Error, Result};
pub use forms::{
    Capabilities, CapabilityCommand, CommandField, CommandForm, ComposedCommand, compose_command,
};
pub use http::HttpApi;
pub use models::{InvestigationsApi, MemoryApi, PanelsApi, RoutingApi};
pub use operations::Operation;
pub use panel_events::{PanelChangeEvent, PanelWatch};
pub use retry::retry_memory;
pub use wire::{
    BudgetForced, CODING_ACTIVITY_KINDS, CodeEvent, CodingActivity, ExecApprovalRequest, Frame,
    Kind, RUN_OUTCOMES, RunResult, VERIFICATIONS, WIRE_PROTOCOL, classify, code_event,
    exec_approval,
};

use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant};

/// The protocol `marina serve <folder> --json` announces.
pub const LOCAL_PROTOCOL: &str = "marina.local.v1";

/// How to connect: a name to log in, or a token to resume a dropped session.
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    pub name: Option<String>,
    pub token: Option<String>,
    /// `agent` (default: may never approve another's held action) or `person`.
    pub principal: String,
    /// The model this participant runs on, shown to others.
    pub model: Option<String>,
    pub command_timeout: Duration,
}

impl ConnectOptions {
    /// Log in under this name (2-20 letters or digits).
    pub fn name(name: &str) -> Self {
        ConnectOptions {
            name: Some(name.into()),
            token: None,
            principal: "agent".into(),
            model: None,
            command_timeout: Duration::from_secs(120),
        }
    }

    /// Resume a dropped session with its token, within 60 s of the drop.
    pub fn token(token: &str) -> Self {
        ConnectOptions {
            name: None,
            token: Some(token.into()),
            ..ConnectOptions::name("")
        }
    }
}

/// How to start a folder's server.
#[derive(Debug, Clone)]
pub struct LocalOptions {
    /// A throwaway database instead of the folder's saved one.
    pub fresh: bool,
    /// How to run the Marina CLI (default `marina` on PATH), e.g.
    /// `["bun", "run", "/path/to/marina/scripts/marina.ts"]`.
    pub command: Vec<String>,
    /// Extra environment for the server (a provider key, `MARINA_DEFAULT_MODEL`, ...).
    pub env: Vec<(String, String)>,
    pub start_timeout: Duration,
}

impl Default for LocalOptions {
    fn default() -> Self {
        LocalOptions {
            fresh: false,
            command: vec!["marina".into()],
            env: vec![],
            start_timeout: Duration::from_secs(90),
        }
    }
}

/// A `marina serve <folder> --json` child and what it announced.
pub struct LocalServer {
    pub url: String,
    pub http: String,
    pub name: String,
    /// The server process (not the `marina serve` launcher).
    pub pid: u64,
    pub folder: String,
    child: Child,
}

impl LocalServer {
    /// Run `marina serve <folder> --json` and wait for its announcement.
    pub fn start(folder: impl AsRef<Path>, options: &LocalOptions) -> Result<LocalServer> {
        let (program, args) = options
            .command
            .split_first()
            .ok_or_else(|| Error::Invalid("LocalOptions.command is empty".into()))?;
        let mut command = Command::new(program);
        command
            .args(args)
            .arg("serve")
            .arg(folder.as_ref())
            .arg("--json");
        if options.fresh {
            command.arg("--fresh");
        }
        // stdin stays a pipe: when this program goes away it closes, and the server stops with it.
        command
            .envs(options.env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|e| {
            Error::Other(format!(
                "Could not run {program}: {e}. Install Marina, or set LocalOptions.command."
            ))
        })?;
        let tail: Arc<Mutex<VecDeque<String>>> = Arc::default();
        if let Some(err) = child.stderr.take() {
            let tail = tail.clone();
            thread::spawn(move || {
                for line in BufReader::new(err)
                    .lines()
                    .map_while(std::result::Result::ok)
                {
                    let mut t = tail.lock().unwrap();
                    t.push_back(line);
                    if t.len() > 40 {
                        t.pop_front();
                    }
                }
            });
        }
        let (tx, rx) = mpsc::channel::<Option<String>>();
        if let Some(out) = child.stdout.take() {
            thread::spawn(move || {
                let mut line = String::new();
                let read = BufReader::new(out)
                    .read_line(&mut line)
                    .ok()
                    .filter(|n| *n > 0);
                let _ = tx.send(read.map(|_| line)); // the waiter may have given up
            });
        }
        let why = |tail: &Arc<Mutex<VecDeque<String>>>| {
            let t = tail.lock().unwrap();
            if t.is_empty() {
                String::new()
            } else {
                let start = t.len().saturating_sub(8);
                format!(
                    "\n{}",
                    t.iter().skip(start).cloned().collect::<Vec<_>>().join("\n")
                )
            }
        };
        let folder_shown = folder.as_ref().display().to_string();
        let line = match rx.recv_timeout(options.start_timeout) {
            Ok(Some(line)) => line,
            Ok(None) => {
                let code = wait_for(&mut child, Duration::from_secs(5));
                thread::sleep(Duration::from_millis(200)); // let the stderr tail arrive
                return Err(Error::Other(format!(
                    "The Marina server for {folder_shown} exited ({code}) before it was ready.{}",
                    why(&tail)
                )));
            }
            Err(_) => {
                stop_child(&mut child);
                return Err(Error::Other(format!(
                    "The Marina server for {folder_shown} was not ready in time.{}",
                    why(&tail)
                )));
            }
        };
        let announced: Map<String, Value> = match serde_json::from_str(&line) {
            Ok(Value::Object(m))
                if m.get("protocol").and_then(Value::as_str) == Some(LOCAL_PROTOCOL) =>
            {
                m
            }
            _ => {
                stop_child(&mut child);
                return Err(Error::Other(format!(
                    "marina serve said something unexpected: {line}"
                )));
            }
        };
        let field = |k: &str| {
            announced
                .get(k)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        Ok(LocalServer {
            url: field("url"),
            http: field("http"),
            name: field("name"),
            pid: announced.get("pid").and_then(Value::as_u64).unwrap_or(0),
            folder: field("folder"),
            child,
        })
    }

    /// Stop the server and wait until it has released the folder's database.
    pub fn stop(&mut self) {
        stop_child(&mut self.child);
    }
}

fn wait_for(child: &mut Child, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into());
        }
        thread::sleep(Duration::from_millis(50));
    }
    "running".into()
}

/// Closing its stdin is `marina serve --json`'s stop signal; it drains, then exits.
fn stop_child(child: &mut Child) {
    drop(child.stdin.take());
    if wait_for(child, Duration::from_secs(45)) == "running" {
        let _ = child.kill(); // stuck: the kernel releases the database lease
        let _ = child.wait();
    }
}

/// One session with a Marina server, and everything it can reach. Dropping it closes it.
pub struct Marina {
    connection: Connection,
    code_session: Mutex<Option<Option<String>>>,
    server: Mutex<Option<LocalServer>>,
    routing: OnceLock<RoutingApi>,
    investigations: OnceLock<InvestigationsApi>,
    panels: OnceLock<PanelsApi>,
}

impl Marina {
    fn wrap(connection: Connection, server: Option<LocalServer>) -> Marina {
        Marina {
            connection,
            code_session: Mutex::new(None),
            server: Mutex::new(server),
            routing: OnceLock::new(),
            investigations: OnceLock::new(),
            panels: OnceLock::new(),
        }
    }

    /// Log in to a running Marina under a name.
    pub fn connect(url: &str, name: &str) -> Result<Marina> {
        Marina::connect_with(url, ConnectOptions::name(name))
    }

    /// Connect to a running Marina.
    pub fn connect_with(url: &str, options: ConnectOptions) -> Result<Marina> {
        if options.name.is_some() == options.token.is_some() {
            return Err(Error::Invalid(
                "Pass a name to log in, or a token to resume a session (one of them).".into(),
            ));
        }
        let mut connection = Connection::new(url, &options.principal, options.model.as_deref())?;
        connection.command_timeout = options.command_timeout;
        let session = match (&options.token, &options.name) {
            (Some(token), _) => connection.resume(token),
            (_, Some(name)) => connection.login(name),
            _ => unreachable!(),
        };
        if let Err(e) = session {
            connection.close();
            return Err(e);
        }
        Ok(Marina::wrap(connection, None))
    }

    /// Start a Marina for a folder and connect as its owner, with the default options.
    pub fn local(folder: impl AsRef<Path>) -> Result<Marina> {
        Marina::local_with(folder, &LocalOptions::default())
    }

    /// Start a Marina for a folder and connect as its owner. It codes in that folder and keeps
    /// its sessions and memory in ~/.marina/projects/ (the same home `marina <folder>` uses).
    /// Closing (or dropping) the `Marina` stops it. Needs the `marina` CLI.
    pub fn local_with(folder: impl AsRef<Path>, options: &LocalOptions) -> Result<Marina> {
        let mut server = LocalServer::start(folder, options)?;
        let connection = match Connection::new(&server.url, "agent", None) {
            Ok(c) => c,
            Err(e) => {
                server.stop();
                return Err(e);
            }
        };
        if let Err(e) = connection.login(&server.name) {
            connection.close();
            server.stop();
            return Err(e);
        }
        Ok(Marina::wrap(connection, Some(server)))
    }

    // ─── The session ───────────────────────────────────────────────────────

    /// The WebSocket session underneath, for anything the front door does not wrap.
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    /// Code Mode: run coding tasks, follow them, review their changes.
    pub fn code(&self) -> Coding<'_> {
        Coding {
            connection: &self.connection,
            session: &self.code_session,
        }
    }

    pub fn session(&self) -> Result<Session> {
        self.connection
            .session()
            .ok_or_else(|| Error::ConnectionLost("Not connected.".into()))
    }

    /// The newest session token: it signs the HTTP calls and resumes a dropped session.
    pub fn token(&self) -> Result<String> {
        Ok(self.session()?.token)
    }

    pub fn url(&self) -> &str {
        self.connection.ws_url()
    }

    pub fn http_url(&self) -> &str {
        self.connection.http_url()
    }

    /// The server pid `local` started, if any.
    pub fn server_pid(&self) -> Option<u64> {
        self.server.lock().unwrap().as_ref().map(|s| s.pid)
    }

    /// Run one world command (`look`, `task list`, ...). Coding tasks go through `code()`: in
    /// Code Mode a command is still a command.
    pub fn command(&self, text: &str) -> Result<CommandResult> {
        self.connection.command(text)
    }

    /// Every command this session may run, with typed forms and JSON Schemas.
    pub fn capabilities(&self) -> Result<Map<String, Value>> {
        self.connection.capabilities()
    }

    /// The capabilities reply, typed: every command with its forms (see [`compose_command`]).
    pub fn capability_manifest(&self) -> Result<Capabilities> {
        Capabilities::from_reply(&self.capabilities()?)
    }

    /// Everything the server sends this session. Returns an id for `connection().off_frame`.
    pub fn on_event(&self, listener: impl Fn(&Frame) + Send + Sync + 'static) -> u64 {
        self.connection.on_frame(listener)
    }

    /// Called with the new session each time the SDK resumes a dropped one (see
    /// [`Connection`]). Returns an id for `connection().off_reconnect`.
    pub fn on_reconnect(&self, callback: impl Fn(&Session) + Send + Sync + 'static) -> u64 {
        self.connection.on_reconnect(callback)
    }

    /// A socket is open (false while the SDK is reconnecting, and after `close()`).
    pub fn is_connected(&self) -> bool {
        self.connection.is_connected()
    }

    // ─── Talking to others ─────────────────────────────────────────────────

    /// Send a private message.
    pub fn tell(&self, target: &str, message: &str) -> Result<()> {
        self.connection.tell(target, message)
    }

    /// Say something to the room.
    pub fn say(&self, message: &str) -> Result<()> {
        self.connection.say(message)
    }

    /// Ask `target` and wait for its answer. See [`agent`] for the rules.
    pub fn tell_and_await(&self, target: &str, message: &str, timeout: Duration) -> Result<String> {
        self.connection.tell_and_await(target, message, timeout)
    }

    /// `tell_and_await` with every option.
    pub fn tell_and_await_with(
        &self,
        target: &str,
        message: &str,
        options: &TellAwaitOptions,
    ) -> Result<String> {
        self.connection
            .tell_and_await_with(target, message, options)
    }

    /// Wait for a tell to you, from `from` (any sender with `None`). Returns its text.
    pub fn wait_for_tell(&self, from: Option<&str>, timeout: Duration) -> Result<String> {
        self.connection.wait_for_tell(from, timeout)
    }

    /// Look at the room, or at something in it.
    pub fn look(&self, target: Option<&str>) -> Result<CommandResult> {
        self.connection.look(target)
    }

    /// Save a note to your memory.
    pub fn note(&self, text: &str) -> Result<CommandResult> {
        self.connection.note(text)
    }

    /// Search your memory.
    pub fn recall(&self, query: &str) -> Result<CommandResult> {
        self.connection.recall(query)
    }

    // ─── HTTP ──────────────────────────────────────────────────────────────

    fn session_api(&self, tag: &str) -> HttpApi {
        let connection = self.connection.clone();
        HttpApi::new(
            self.http_url(),
            move || connection.session().map(|s| s.token).unwrap_or_default(),
            Some(tag),
        )
    }

    /// Participant routing (`/api/routing`), signed in as this session. Typed methods, and
    /// `call` for anything newer.
    pub fn routing(&self) -> &RoutingApi {
        self.routing
            .get_or_init(|| RoutingApi::new(self.session_api("routing")))
    }

    /// Investigations (`/api/investigations`), signed in as this session.
    pub fn investigations(&self) -> &InvestigationsApi {
        self.investigations
            .get_or_init(|| InvestigationsApi::new(self.session_api("investigations")))
    }

    /// Published panels (`/api/canvases`), signed in as this session.
    pub fn panels(&self) -> &PanelsApi {
        self.panels
            .get_or_init(|| PanelsApi::new(self.session_api("panels")))
    }

    /// Memory (`/v1/memory`), with a memory credential of its own (never the session token).
    pub fn memory(&self, credential: &str) -> MemoryApi {
        let credential = credential.to_string();
        MemoryApi::new(HttpApi::new(
            self.http_url(),
            move || credential.clone(),
            Some("memory"),
        ))
    }

    /// Watch the live panel event stream (`/dashboard-ws`), signed with this session's newest
    /// token. `on_snapshot` runs on every (re)connection: reread then. Events are hints to read
    /// again, never content. Stop with the returned handle (or by dropping it).
    pub fn watch_changes(
        &self,
        on_event: impl Fn(&PanelChangeEvent) + Send + 'static,
        on_snapshot: impl Fn() + Send + 'static,
    ) -> PanelWatch {
        let connection = self.connection.clone();
        panel_events::watch_changes(
            self.http_url(),
            move || connection.session().map(|s| s.token).unwrap_or_default(),
            on_event,
            on_snapshot,
        )
    }

    /// Disconnect, and stop the server if `local` started it.
    pub fn close(&self) {
        self.connection.close();
        if let Some(mut server) = self.server.lock().unwrap().take() {
            server.stop();
        }
    }
}

impl Drop for Marina {
    fn drop(&mut self) {
        self.close();
    }
}
