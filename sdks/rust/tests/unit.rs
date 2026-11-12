// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! Unit tests: no Marina server needed. `cargo test`.

use marina_sdk::operations::OPERATIONS;
use marina_sdk::*;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

fn frame(v: Value) -> Frame {
    v.as_object().unwrap().clone()
}

#[test]
fn classifies_frames_in_the_protocol_order() {
    let cases = [
        (
            json!({"kind": "auth_error", "data": {"text": "x"}}),
            Kind::AuthError,
        ),
        (
            json!({"kind": "error", "data": {"text": "x", "command_result": {}}}),
            Kind::Error,
        ),
        (
            json!({"kind": "system", "data": {"command_result": {"request_id": "1", "ok": true}}}),
            Kind::CommandResult,
        ),
        (
            json!({"kind": "system", "data": {"entityId": "e_1", "token": "t"}}),
            Kind::Session,
        ),
        (
            json!({"kind": "system", "data": {"protocol": "marina.wire.v1", "schema": "/api/protocol"}}),
            Kind::Welcome,
        ),
        (
            json!({"kind": "system", "tag": "capabilities", "data": {}}),
            Kind::CapabilitiesReply,
        ),
        (
            json!({"kind": "message", "data": {"execApproval": {"token": "t"}, "code": {}}}),
            Kind::ExecApproval,
        ),
        (
            json!({"kind": "message", "tag": "code", "data": {"code": {"event": "x"}}}),
            Kind::Code,
        ),
        (
            json!({"kind": "message", "tag": "tell", "data": {}}),
            Kind::Tell,
        ),
        (
            json!({"kind": "room", "data": {"text": "A room"}}),
            Kind::Output,
        ),
    ];
    for (f, expected) in cases {
        assert_eq!(classify(&frame(f.clone())), expected, "{f}");
    }
}

#[test]
fn reads_a_step_and_a_run_end() {
    let step = code_event(&frame(json!({"kind": "message", "tag": "code", "data": {"text": "Edit a.ts", "code": {
        "event": "agent_output", "type": "stream", "sessionId": "s",
        "metadata": {"kind": "tool", "activity": {"kind": "edit", "label": "Edit a.ts", "path": "a.ts", "diff": ["-a", "+b"], "more": 2}}}}})))
    .unwrap();
    assert_eq!(step.kind.as_deref(), Some("tool"));
    assert_eq!(step.payload_type, "stream");
    assert_eq!(
        step.activity.unwrap(),
        CodingActivity {
            kind: "edit".into(),
            label: "Edit a.ts".into(),
            path: Some("a.ts".into()),
            diff: Some(vec!["-a".into(), "+b".into()]),
            more: Some(2),
            quiet: None
        }
    );
    // A blocked run carries its phase on the event, not in the metadata.
    let end = code_event(&frame(json!({"data": {"text": "t", "code": {"event": "code_lifecycle", "type": "lifecycle", "phase": "failed",
        "metadata": {"runId": "task_run_1", "reason": "blocked", "terminal": true, "outcome": "interrupted", "taskId": 7,
                     "budgetForced": {"reason": "spend", "used": 3}}}}})))
    .unwrap();
    let r = end.result.unwrap();
    assert_eq!(
        (r.run_id.as_str(), r.phase.as_str(), r.task_id),
        ("task_run_1", "failed", Some(7))
    );
    assert_eq!(
        r.budget_forced,
        Some(BudgetForced {
            reason: "spend".into(),
            used: Some(3.0),
            cap: None
        })
    );
    assert!(!r.submitted() && !r.verified());
    assert_eq!(r.raw["phase"], "failed");
    // Serialized with the protocol's names.
    let wire = serde_json::to_value(&r).unwrap();
    assert_eq!(wire["runId"], "task_run_1");
    assert_eq!(wire["budgetForced"]["reason"], "spend");
    let no_end = code_event(&frame(
        json!({"data": {"code": {"event": "code_lifecycle", "metadata": {"runId": "r"}}}}),
    ))
    .unwrap();
    assert!(no_end.result.is_none());
    assert!(exec_approval(&frame(json!({"data": {"execApproval": {"token": "t"}}}))).is_none());
}

#[test]
fn exec_answers_budgets_and_endpoints() {
    let request = ExecApprovalRequest {
        token: "tok".into(),
        argv: vec!["make".into()],
        cwd: "/w".into(),
        rendered: "make".into(),
    };
    assert_eq!(exec_answer(true, &request), "code exec-approve tok");
    assert_eq!(exec_answer(false, &request), "code exec-deny tok");
    assert_eq!(budget_argument(Duration::from_secs(90)).unwrap(), "90s");
    assert_eq!(budget_argument(Duration::from_millis(200)).unwrap(), "1s");
    assert!(budget_argument(Duration::ZERO).is_err());
    assert_eq!(
        endpoints("http://127.0.0.1:3300/").unwrap(),
        (
            "ws://127.0.0.1:3300/ws".into(),
            "http://127.0.0.1:3300".into()
        )
    );
    assert_eq!(
        endpoints("ws://localhost:3300/ws").unwrap(),
        (
            "ws://localhost:3300/ws".into(),
            "http://localhost:3300".into()
        )
    );
    assert_eq!(
        endpoints("wss://m.example/world").unwrap(),
        (
            "wss://m.example/world/ws".into(),
            "https://m.example/world".into()
        )
    );
    assert!(endpoints("ws://u:p@host").is_err());
    // A name and a token at once is refused before anything is sent.
    let both = ConnectOptions {
        token: Some("t".into()),
        ..ConnectOptions::name("a")
    };
    assert!(matches!(
        Marina::connect_with("ws://127.0.0.1:1", both),
        Err(Error::Invalid(_))
    ));
}

#[test]
fn a_command_error_states_the_refusal_once() {
    let e = Error::Command {
        reason: "No such room.".into(),
        frames: vec![
            frame(json!({"data": {"text": "No such room. Try look."}})),
            frame(json!({"data": {"text": "x"}})),
        ],
    };
    let text = e.to_string();
    assert!(text.starts_with("No such room. Try look."), "{text}");
    assert!(text.contains("\nx"));
}

struct Seen {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// A tiny HTTP/1.1 server that records each request and answers by path.
fn server() -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let log = seen.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            let mut parts = first.split_whitespace();
            let (method, path) = (
                parts.next().unwrap_or("").to_string(),
                parts.next().unwrap_or("").to_string(),
            );
            let mut headers = Vec::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let line = line.trim_end();
                if line.is_empty() {
                    break;
                }
                if let Some((k, v)) = line.split_once(':') {
                    headers.push((k.trim().to_string(), v.trim().to_string()));
                }
            }
            let length: usize = headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, v)| v.parse().ok())
                .unwrap_or(0);
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let (status, reply, extra) = if path.contains("memfail") {
                (
                    "429 Too Many Requests",
                    r#"{"error":{"code":"rate_limited","message":"slow","retry_after_ms":1500}}"#,
                    "Retry-After: 2\r\n",
                )
            } else if path.contains("gone") {
                (
                    "404 Not Found",
                    r#"{"error":"No session","code":"not_found"}"#,
                    "",
                )
            } else if path.contains("redirect") {
                ("302 Found", "{}", "Location: http://elsewhere.invalid/\r\n")
            } else {
                ("200 OK", r#"{"ok":true}"#, "")
            };
            log.lock().unwrap().push(Seen {
                method,
                path,
                headers,
                body: String::from_utf8_lossy(&body).into(),
            });
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{reply}",
                reply.len()
            );
        }
    });
    (base, seen)
}

#[test]
fn http_fills_paths_queries_bodies_and_keys() {
    assert_eq!(OPERATIONS.len(), 117);
    let tags: HashSet<&str> = OPERATIONS.iter().map(|o| o.tag).collect();
    assert_eq!(
        tags,
        HashSet::from(["memory", "routing", "investigations", "panels"])
    );
    let (base, seen) = server();
    let memory = HttpApi::new(&base, || "cred".into(), Some("memory"));
    memory
        .call_with_key(
            "remember",
            &[("space", json!("a b/c"))],
            Some(json!({"content": "x"})),
            Some("k1"),
        )
        .unwrap();
    memory
        .call(
            "get",
            &[
                ("space", json!("s")),
                ("id", json!("r1")),
                ("version", json!(3)),
            ],
            None,
        )
        .unwrap();
    memory
        .call("createSpace", &[], Some(json!({"name": "n"})))
        .unwrap();
    {
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].method, "POST");
        assert_eq!(seen[0].path, "/v1/memory/spaces/a%20b%2Fc/records");
        assert_eq!(seen[0].header("authorization"), Some("Bearer cred"));
        assert_eq!(seen[0].header("idempotency-key"), Some("k1"));
        assert_eq!(
            serde_json::from_str::<Value>(&seen[0].body).unwrap(),
            json!({"content": "x"})
        );
        assert_eq!(seen[1].path, "/v1/memory/spaces/s/records/r1?version=3");
        assert!(
            seen[1].header("idempotency-key").is_none(),
            "a read takes no key"
        );
        assert!(
            seen[2].header("idempotency-key").is_some(),
            "a write without a key gets one"
        );
    }
    // Refused before anything is sent.
    let before = seen.lock().unwrap().len();
    assert!(matches!(
        memory.call("get", &[("id", json!("r1"))], None),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        memory.call("remember", &[("space", json!("s"))], None),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        memory.call("me", &[("bogus", json!(1))], None),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        memory.call("discover", &[], None),
        Err(Error::Invalid(_))
    ));
    assert_eq!(seen.lock().unwrap().len(), before);
    let routing = HttpApi::new(&base, || "session-token".into(), Some("routing"));
    assert!(
        routing
            .operations()
            .iter()
            .any(|o| o.name == "join_session")
    );
    match memory.call("space", &[("space", json!("memfail"))], None) {
        Err(Error::Api {
            status: 429,
            code,
            retry_after_ms: Some(1500),
            ..
        }) => assert_eq!(code, "rate_limited"),
        other => panic!("expected a 429, got {other:?}"),
    }
    match routing.call("leave", &[("session", json!("gone"))], Some(json!({}))) {
        Err(Error::Api {
            status: 404, code, ..
        }) => assert_eq!(code, "not_found"),
        other => panic!("expected a 404, got {other:?}"),
    }
    assert_eq!(
        seen.lock().unwrap().last().unwrap().header("authorization"),
        Some("Bearer session-token")
    );
    match memory.call("space", &[("space", json!("redirect"))], None) {
        Err(Error::Api { status: 302, .. }) => {}
        other => panic!("expected the redirect to be refused, got {other:?}"),
    }
}
