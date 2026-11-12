// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! Code Mode: run a coding task, follow its steps, get its result, review its change.

use crate::client::Connection;
use crate::error::{Error, Result};
use crate::wire::{
    CodeEvent, CodingActivity, ExecApprovalRequest, RunResult, code_event, data_of, exec_approval,
};
use serde_json::Value;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

/// Default wait before a run is stopped: 30 minutes.
pub const DEFAULT_RUN_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// What counts as done.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Verification {
    /// The project's checks run on the change (default).
    #[default]
    Checks,
    /// The coder's own checks stand.
    Candidate,
    /// The delivery checklist.
    Delivery,
}

impl Verification {
    fn as_str(self) -> &'static str {
        match self {
            Verification::Checks => "checks",
            Verification::Candidate => "candidate",
            Verification::Delivery => "delivery",
        }
    }
}

/// Your verdict on a run's change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Approve,
    Reject,
}

/// Options for [`Coding::run`].
#[derive(Debug, Clone)]
pub struct RunOptions {
    pub verification: Verification,
    /// Wall-clock budget for the coder. At the deadline it hands in what it has, labelled
    /// `budget_forced`.
    pub budget: Option<Duration>,
    /// Give up waiting after this long: the run is stopped and its result is an error.
    pub timeout: Duration,
}

impl Default for RunOptions {
    fn default() -> Self {
        RunOptions {
            verification: Verification::Checks,
            budget: None,
            timeout: DEFAULT_RUN_TIMEOUT,
        }
    }
}

/// `budget:` for `code do`: whole seconds, at least one.
pub fn budget_argument(budget: Duration) -> Result<String> {
    if budget.is_zero() {
        return Err(Error::Invalid("budget must be positive".into()));
    }
    Ok(format!("{}s", budget.as_millis().div_ceil(1000).max(1)))
}

/// The command that answers an exec request: approve only when the handler says yes.
pub fn exec_answer(approved: bool, request: &ExecApprovalRequest) -> String {
    format!(
        "code {} {}",
        if approved {
            "exec-approve"
        } else {
            "exec-deny"
        },
        request.token
    )
}

struct State {
    run_id: Option<String>,
    result: Option<std::result::Result<RunResult, Error>>,
}

/// One coding task, from dispatch to its Run result.
///
/// ```no_run
/// # fn demo(marina: &marina_sdk::Marina) -> marina_sdk::Result<()> {
/// let run = marina.code().run("Fix the off-by-one in paginate()", Default::default())?;
/// for step in run.steps() {
///     println!("{}", step.label);
/// }
/// let result = run.result()?;
/// # Ok(()) }
/// ```
pub struct CodingRun {
    events: Mutex<Option<Receiver<CodeEvent>>>,
    state: Arc<(Mutex<State>, Condvar)>,
}

impl CodingRun {
    /// The run's id once the server has accepted it (`task_run_...`).
    pub fn run_id(&self) -> Option<String> {
        self.state.0.lock().unwrap().run_id.clone()
    }

    pub fn is_done(&self) -> bool {
        self.state.0.lock().unwrap().result.is_some()
    }

    /// Every coding event of this run's session while it runs, in order. Blocks; read once.
    pub fn events(&self) -> impl Iterator<Item = CodeEvent> {
        let rx = self.events.lock().unwrap().take();
        rx.into_iter().flat_map(|rx| rx.into_iter())
    }

    /// Only the coder's steps (reads, edits with their diffs, checks). Blocks; read once.
    pub fn steps(&self) -> impl Iterator<Item = CodingActivity> {
        self.events().filter_map(|e| e.activity)
    }

    /// Wait for the Run result (completed or failed).
    pub fn result(&self) -> Result<RunResult> {
        let (lock, done) = &*self.state;
        let mut state = lock.lock().unwrap();
        while state.result.is_none() {
            state = done.wait(state).unwrap();
        }
        state.result.clone().unwrap()
    }

    /// Wait at most `timeout` for the Run result.
    pub fn result_timeout(&self, timeout: Duration) -> Result<RunResult> {
        let (lock, done) = &*self.state;
        let (state, _) = done
            .wait_timeout_while(lock.lock().unwrap(), timeout, |s| s.result.is_none())
            .unwrap();
        state.result.clone().unwrap_or_else(|| {
            Err(Error::CodingTimeout(
                "The coding run has not finished yet.".into(),
            ))
        })
    }
}

fn settle(state: &(Mutex<State>, Condvar), outcome: std::result::Result<RunResult, Error>) -> bool {
    let mut s = state.0.lock().unwrap();
    if s.result.is_some() {
        return false;
    }
    s.result = Some(outcome);
    state.1.notify_all();
    true
}

/// Code Mode for one connection: run tasks in the server's workspace and follow them.
pub struct Coding<'a> {
    pub(crate) connection: &'a Connection,
    pub(crate) session: &'a Mutex<Option<Option<String>>>,
}

impl Coding<'_> {
    /// Enter Code Mode (once per connection). Returns the coding session id, or `None` when it
    /// has none yet. The server picks the workspace: a local folder server codes in its folder.
    pub fn open(&self) -> Result<Option<String>> {
        let mut opened = self.session.lock().unwrap();
        if let Some(session) = opened.as_ref() {
            return Ok(session.clone());
        }
        let mut session = None;
        for frame in self.connection.command("code")?.frames {
            if let Some(code) = data_of(&frame).get("code").and_then(Value::as_object)
                && code.get("event").and_then(Value::as_str) == Some("code_mode_entered")
            {
                session = code
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
        }
        *opened = Some(session.clone());
        Ok(session)
    }

    /// Dispatch a coding task; returns once the server accepts it.
    pub fn run(&self, task: &str, options: RunOptions) -> Result<CodingRun> {
        let text = task.trim();
        if text.is_empty() {
            return Err(Error::Invalid("Empty task: nothing to do.".into()));
        }
        let budget = match options.budget {
            Some(b) => format!("budget:{} ", budget_argument(b)?),
            None => String::new(),
        };
        let session_id = self.open()?;
        let state = Arc::new((
            Mutex::new(State {
                run_id: None,
                result: None,
            }),
            Condvar::new(),
        ));
        let (tx, rx): (Sender<CodeEvent>, Receiver<CodeEvent>) = mpsc::channel();
        let sender = Arc::new(Mutex::new(Some(tx)));
        let (st, out) = (state.clone(), sender.clone());
        // On the socket thread: frames reach the run in order, before any listener.
        let waiter = self.connection.add_waiter(move |frame| {
            let Some(event) = code_event(frame) else {
                return;
            };
            if let (Some(mine), Some(theirs)) = (&session_id, &event.session_id)
                && mine != theirs
            {
                return;
            }
            let mut s = st.0.lock().unwrap();
            if s.result.is_some() {
                return;
            }
            if s.run_id.is_none() && event.event == "code_lifecycle" && event.result.is_none() {
                s.run_id = event.run_id.clone();
            }
            if let (Some(result), Some(mine)) = (&event.result, &s.run_id)
                && &result.run_id != mine
            {
                return; // another run's late end
            }
            let ended = event.result.clone().filter(|_| s.run_id.is_some());
            drop(s);
            if let Some(tx) = out.lock().unwrap().as_ref() {
                let _ = tx.send(event);
            }
            if let Some(result) = ended {
                settle(&st, Ok(result));
                out.lock().unwrap().take();
            }
        });
        let (st, out) = (state.clone(), sender.clone());
        let closer = self.connection.add_close(move || {
            settle(
                &st,
                Err(Error::ConnectionLost(
                    "The connection closed before the coding run ended.".into(),
                )),
            );
            out.lock().unwrap().take();
        });
        // A program drives this run: nobody is at a keyboard to answer questions.
        let dispatched = self.connection.command(&format!(
            "code do verification:{} owner:unattended {budget}-- {text}",
            options.verification.as_str()
        ));
        if let Err(e) = dispatched {
            self.connection.remove_waiter(waiter);
            self.connection.remove_close(closer);
            return Err(e);
        }
        let run = CodingRun {
            events: Mutex::new(Some(rx)),
            state: state.clone(),
        };
        // Settle on timeout (and stop the coder); the waiter goes once the run has ended.
        let timeout = options.timeout;
        let st = state.clone();
        let connection = self.connection.clone();
        thread::spawn(move || {
            let (lock, done) = &*st;
            let (guard, timed_out) = done
                .wait_timeout_while(lock.lock().unwrap(), timeout, |s| s.result.is_none())
                .unwrap();
            drop(guard);
            if timed_out.timed_out() {
                let _ = connection.command("code stop"); // the timeout below reports the run
                settle(
                    &st,
                    Err(Error::CodingTimeout(format!(
                        "The coding run did not finish within {} s; it was stopped.",
                        timeout.as_secs()
                    ))),
                );
                sender.lock().unwrap().take();
            }
            connection.remove_waiter(waiter);
            connection.remove_close(closer);
        });
        Ok(run)
    }

    /// Answer the coder's requests to run commands outside its allowlist. The handler returns
    /// true to run the command; false (or a panic) denies it. Without a handler the requests
    /// wait for someone else to answer.
    pub fn on_exec_approval(
        &self,
        handler: impl Fn(&ExecApprovalRequest) -> bool + Send + Sync + 'static,
    ) -> u64 {
        let connection = self.connection.clone();
        self.connection.on_frame(move |frame| {
            if let Some(request) = exec_approval(frame) {
                let approved =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(&request)))
                        .unwrap_or(false);
                let _ = connection.command(&exec_answer(approved, &request)); // not delivered: the request stays open
            }
        })
    }

    /// The session's whole change as a unified diff ("" when nothing changed).
    pub fn diff(&self, path: Option<&str>) -> Result<String> {
        self.open()?;
        let command = match path {
            Some(p) => format!("code diff {p}"),
            None => "code diff".into(),
        };
        for frame in self.connection.command(&command)?.frames {
            if let Some(code) = data_of(&frame).get("code").and_then(Value::as_object)
                && code.get("type").and_then(Value::as_str) == Some("diff")
                && let Some(content) = code.get("content").and_then(Value::as_str)
            {
                return Ok(content.to_string());
            }
        }
        Ok(String::new())
    }

    /// Record your verdict on a run's change.
    pub fn review(&self, run_id: &str, verdict: Verdict) -> Result<()> {
        if run_id.is_empty()
            || run_id.len() > 128
            || !run_id
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
        {
            return Err(Error::Invalid(format!("Not a run id: {run_id}")));
        }
        let verb = if verdict == Verdict::Approve {
            "approve"
        } else {
            "reject"
        };
        self.connection
            .command(&format!("code review {verb} {run_id}"))
            .map(|_| ())
    }

    /// Redirect the coder while it works.
    pub fn steer(&self, direction: &str) -> Result<()> {
        self.connection
            .command(&format!("code steer {direction}"))
            .map(|_| ())
    }

    /// Stop the coder.
    pub fn stop(&self) -> Result<()> {
        self.connection.command("code stop").map(|_| ())
    }
}
