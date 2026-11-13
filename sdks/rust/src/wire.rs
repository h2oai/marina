// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! `marina.wire.v1`: what the server sends, read into Rust.
//!
//! The protocol is protocol/README.md and protocol/marina.wire.v1.schema.json in the Marina
//! repository. The coding types serialize with exactly the schema's field names; the
//! repository's tests hold them to it.

use serde::Serialize;
use serde_json::{Map, Value};

/// One server frame: `{"kind": ..., "timestamp": ..., "tag"?: ..., "data": {...}}`.
pub type Frame = Map<String, Value>;

pub const WIRE_PROTOCOL: &str = "marina.wire.v1";

/// What kind of step a coding activity is.
pub const CODING_ACTIVITY_KINDS: [&str; 10] = [
    "read", "search", "edit", "write", "patch", "run", "verify", "plan", "summary", "other",
];
/// What the checks said. Only `passed` means checks ran on the change and passed;
/// `not_applicable`: the task changed no files, so there was nothing to verify.
pub const VERIFICATIONS: [&str; 9] = [
    "passed",
    "not_applicable",
    "failed",
    "not_run",
    "error",
    "missing",
    "stale",
    "unbound",
    "unavailable",
];
/// How a run ended. `submitted`: the coder handed the change in for review.
pub const RUN_OUTCOMES: [&str; 4] = ["submitted", "failed", "cancelled", "interrupted"];

/// Well-known server frames, as the protocol's dispatch rule names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Welcome,
    Session,
    AuthError,
    CommandResult,
    Error,
    CapabilitiesReply,
    ContextPreviewReply,
    MemoryService,
    ExecApproval,
    Code,
    Tell,
    Onboarding,
    /// Ordinary world output.
    Output,
}

static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();

/// The frame's `data` object (empty when missing).
pub fn data_of(frame: &Frame) -> &Map<String, Value> {
    frame
        .get("data")
        .and_then(Value::as_object)
        .unwrap_or_else(|| EMPTY.get_or_init(Map::new))
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(_) => true,
    }
}

/// Which well-known frame this is, by the protocol's order ("Telling frames apart").
pub fn classify(frame: &Frame) -> Kind {
    let data = data_of(frame);
    let kind = frame.get("kind").and_then(Value::as_str);
    let tag = frame.get("tag").and_then(Value::as_str);
    if kind == Some("auth_error") {
        return Kind::AuthError;
    }
    if kind == Some("error") {
        return Kind::Error;
    }
    if truthy(data.get("command_result")) {
        return Kind::CommandResult;
    }
    if kind == Some("system") && data.get("entityId").is_some_and(Value::is_string) {
        return Kind::Session;
    }
    if kind == Some("system") && truthy(data.get("protocol")) && truthy(data.get("schema")) {
        return Kind::Welcome;
    }
    match tag {
        Some("capabilities") => return Kind::CapabilitiesReply,
        Some("context_preview") => return Kind::ContextPreviewReply,
        _ => {}
    }
    if truthy(data.get("memory_service")) {
        return Kind::MemoryService;
    }
    if truthy(data.get("execApproval")) {
        return Kind::ExecApproval;
    }
    if truthy(data.get("code")) {
        return Kind::Code;
    }
    match tag {
        Some("tell") => Kind::Tell,
        Some("onboarding") => Kind::Onboarding,
        _ => Kind::Output,
    }
}

/// The frame's text for people (may carry ANSI colour codes), or "".
pub fn text_of(frame: &Frame) -> String {
    data_of(frame)
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// One step the coder took.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CodingActivity {
    /// One of [`CODING_ACTIVITY_KINDS`].
    pub kind: String,
    /// One line in plain words: "Edit paginate.js".
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The change, as unified-diff body lines (`-old`, `+new`, ` context`), capped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<Vec<String>>,
    /// Diff lines left out past the cap.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub more: Option<i64>,
    /// Bookkeeping; a UI may hide it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quiet: Option<bool>,
}

/// Present on a Run result when a budget forced the answer; never a free answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BudgetForced {
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cap: Option<f64>,
}

/// How a coding run ended. Review it with `marina.code().review(&result.run_id, Verdict::Approve)`.
/// Serializes with the protocol's field names (`runId`, ...).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub run_id: String,
    /// Always true.
    pub terminal: bool,
    /// `completed` or `failed`.
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// One of [`RUN_OUTCOMES`]. `submitted`: handed in for review.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// `blocked`, `agent_died`, or free text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_id: Option<String>,
    /// One of [`VERIFICATIONS`]. Only `passed` means checks ran on the change and passed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_forced: Option<BudgetForced>,
    /// Everything the server sent, including fields newer than this SDK.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

impl RunResult {
    /// The coder finished and handed the change in for review.
    pub fn submitted(&self) -> bool {
        self.outcome.as_deref() == Some("submitted")
    }

    /// Checks ran on the change and passed.
    pub fn verified(&self) -> bool {
        self.verification.as_deref() == Some("passed")
    }
}

/// One coding event, as the server sent it (`data.code` of a `code` frame).
#[derive(Debug, Clone)]
pub struct CodeEvent {
    /// `agent_output`, `code_lifecycle`, `verification_finished`, ...
    pub event: String,
    /// Payload shape: `stream`, `lifecycle`, `diff`, `file`, `verification`, ...
    pub payload_type: String,
    /// For people: print it as is (it may carry ANSI colour codes).
    pub text: String,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub phase: Option<String>,
    /// On `agent_output`: a step (`tool`), the coder's words (`prose`), or a failure.
    pub kind: Option<String>,
    /// On a step: what the coder did.
    pub activity: Option<CodingActivity>,
    /// On the end of a run.
    pub result: Option<RunResult>,
    /// The whole frame.
    pub raw: Frame,
}

/// The coder asks to run a command outside its allowlist.
#[derive(Debug, Clone, PartialEq)]
pub struct ExecApprovalRequest {
    pub token: String,
    pub argv: Vec<String>,
    pub cwd: String,
    /// The command as one line, for people.
    pub rendered: String,
}

fn string(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_string)
}

fn activity(v: Option<&Value>) -> Option<CodingActivity> {
    let a = v?.as_object()?;
    Some(CodingActivity {
        kind: a.get("kind")?.as_str()?.to_string(),
        label: a.get("label")?.as_str()?.to_string(),
        path: string(a.get("path")),
        diff: a.get("diff").and_then(Value::as_array).map(|lines| {
            lines
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        }),
        more: a.get("more").and_then(Value::as_i64),
        quiet: a.get("quiet").and_then(Value::as_bool),
    })
}

/// A run's end: a `code_lifecycle` event whose metadata says `terminal: true`.
fn run_result(code: &Map<String, Value>) -> Option<RunResult> {
    let meta = code.get("metadata")?.as_object()?;
    if code.get("event").and_then(Value::as_str) != Some("code_lifecycle")
        || meta.get("terminal") != Some(&Value::Bool(true))
    {
        return None;
    }
    let run_id = meta.get("runId")?.as_str()?.to_string();
    let phase = meta
        .get("phase")
        .or_else(|| code.get("phase"))
        .and_then(Value::as_str);
    let ended = if phase == Some("completed") {
        "completed"
    } else {
        "failed"
    };
    let mut raw = meta.clone();
    raw.insert("phase".into(), Value::String(ended.into()));
    Some(RunResult {
        run_id,
        terminal: true,
        phase: ended.into(),
        task_id: meta.get("taskId").and_then(Value::as_i64),
        agent: string(meta.get("agent")),
        outcome: string(meta.get("outcome")),
        reason: string(meta.get("reason")),
        detail: string(meta.get("detail")),
        summary: string(meta.get("summary")),
        summary_id: string(meta.get("summaryId")),
        verification: string(meta.get("verification")),
        verification_reason: string(meta.get("verificationReason")),
        budget_forced: meta
            .get("budgetForced")
            .and_then(Value::as_object)
            .map(|b| BudgetForced {
                reason: b
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                used: b.get("used").and_then(Value::as_f64),
                cap: b.get("cap").and_then(Value::as_f64),
            }),
        raw,
    })
}

/// The coding event a frame carries, or `None`.
pub fn code_event(frame: &Frame) -> Option<CodeEvent> {
    let code = data_of(frame).get("code")?.as_object()?;
    let event = code.get("event")?.as_str()?.to_string();
    let empty = Map::new();
    let meta = code
        .get("metadata")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    Some(CodeEvent {
        event,
        payload_type: string(code.get("type")).unwrap_or_default(),
        text: text_of(frame),
        session_id: string(code.get("sessionId")),
        run_id: string(meta.get("runId")),
        phase: string(code.get("phase")),
        kind: string(meta.get("kind")),
        activity: activity(meta.get("activity")),
        result: run_result(code),
        raw: frame.clone(),
    })
}

/// The exec approval request a frame carries, or `None`.
pub fn exec_approval(frame: &Frame) -> Option<ExecApprovalRequest> {
    let r = data_of(frame).get("execApproval")?.as_object()?;
    let token = r.get("token")?.as_str()?;
    if token.is_empty() {
        return None;
    }
    Some(ExecApprovalRequest {
        token: token.to_string(),
        argv: r
            .get("argv")?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        cwd: r.get("cwd")?.as_str()?.to_string(),
        rendered: r.get("rendered")?.as_str()?.to_string(),
    })
}
