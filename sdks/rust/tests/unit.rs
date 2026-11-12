// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! Unit tests: no Marina server needed. `cargo test`.

use marina_sdk::operations::OPERATIONS;
use marina_sdk::*;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
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

// ─── Agent helpers ─────────────────────────────────────────────────────────

#[test]
fn tell_notices_and_correlation_tags_follow_the_typescript_rules() {
    for notice in [
        "[notice] paused",
        "  [NOTICE] budget",
        "I've spent my model-call budget for today.",
        "I've hit a spend cap and paused.",
        "I've hit 3 consecutive upstream errors; pausing.",
    ] {
        assert!(is_tell_notice(notice), "{notice}");
    }
    for reply in [
        "pong",
        "I've spent my model-call budgets",
        "I've hit a wall",
        "I've hit and paused",
        "I've hit a snag and pausedly",
        "I've hit many consecutive upstream errors",
    ] {
        assert!(!is_tell_notice(reply), "{reply}");
    }
    assert_eq!(correlation_tag("ab12cd"), " [re:ab12cd]");
    assert!(has_correlation_tag("pong [re:ab12cd]", "ab12cd"));
    assert!(has_correlation_tag("pong re:ab12cd", "ab12cd"));
    assert!(!has_correlation_tag("pong [re:zz]", "ab12cd"));
    assert_eq!(strip_correlation_tag("pong [re:ab12cd]", "ab12cd"), "pong");
    assert_eq!(
        strip_correlation_tag("pong re:ab12cd done", "ab12cd"),
        "pong done"
    );
    assert_eq!(strip_correlation_tag("[re:ab12cd] pong", "ab12cd"), "pong");
    let id = marina_sdk::agent::new_correlation_id();
    assert_eq!(id.len(), 6);
    assert!(
        id.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    );
    let tell = frame(
        json!({"kind": "message", "tag": "tell", "data": {"senderName": "Peer", "message": "hi"}}),
    );
    assert_eq!(tell_of(&tell), Some(("Peer".into(), "hi".into())));
    let echo =
        frame(json!({"kind": "message", "tag": "tell", "data": {"text": "You tell Peer: hi"}}));
    assert_eq!(
        tell_of(&echo),
        None,
        "the echo of your own tell names no sender"
    );
}

#[test]
fn reconnect_backoff_doubles_from_three_seconds_to_thirty() {
    let waits: Vec<u64> = (0..7).map(|a| reconnect_delay(a).as_secs()).collect();
    assert_eq!(waits, [3, 6, 12, 24, 30, 30, 30]);
    assert_eq!(MAX_RECONNECT_ATTEMPTS, 10);
    let panel: Vec<u64> = (0..6)
        .map(|a| marina_sdk::panel_events::panel_reconnect_delay(a).as_millis() as u64)
        .collect();
    assert_eq!(panel, [1000, 2000, 4000, 8000, 15000, 15000]);
}

// ─── A scripted WebSocket server ───────────────────────────────────────────

/// Logs every client frame; answers login/auth with a session (token t1, t2, ...), commands
/// with a result. `drop` closes the socket from the server side; `tell Peer ...` gets an echo,
/// a notice, an untagged reply and a tagged one.
fn ws_server() -> (String, Arc<Mutex<Vec<Value>>>) {
    use tungstenite::{Message, accept};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let log: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen = log.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let log = seen.clone();
            thread::spawn(move || {
                let Ok(mut ws) = accept(stream) else { return };
                let send = |ws: &mut tungstenite::WebSocket<std::net::TcpStream>, v: Value| {
                    let _ = ws.send(Message::text(v.to_string()));
                };
                while let Ok(message) = ws.read() {
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else {
                        continue;
                    };
                    log.lock().unwrap().push(v.clone());
                    let session = |token: String| json!({"kind": "system", "timestamp": 0, "data": {"entityId": "e_1", "name": "rs", "token": token}});
                    match v["type"].as_str() {
                        Some("login") => send(&mut ws, session("t1".into())),
                        Some("auth") => {
                            let n: u32 = v["token"].as_str().unwrap_or("t0")[1..]
                                .parse()
                                .unwrap_or(0);
                            send(&mut ws, session(format!("t{}", n + 1)));
                        }
                        Some("command") => {
                            let id = v["request_id"].clone();
                            let line = v["command"].as_str().unwrap_or("").to_string();
                            let done = json!({"kind": "system", "timestamp": 0, "data": {"command_result": {"request_id": id, "ok": true}}});
                            if let Some(rest) = line.strip_prefix("tell Peer ") {
                                let tag = rest
                                    .rsplit_once(" [re:")
                                    .map(|(_, t)| t.trim_end_matches(']').to_string())
                                    .unwrap_or_default();
                                let now = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap()
                                    .as_millis() as u64;
                                let tell = |text: String| json!({"kind": "message", "tag": "tell", "timestamp": now + 10, "data": {"senderName": "Peer", "message": text}});
                                send(
                                    &mut ws,
                                    json!({"kind": "message", "tag": "tell", "timestamp": now, "command_request_id": id, "data": {"text": format!("You tell Peer: {rest}")}}),
                                );
                                send(&mut ws, done);
                                send(&mut ws, tell("[notice] paused".into()));
                                send(&mut ws, tell("an untagged aside".into()));
                                send(&mut ws, tell(format!("pong [re:{tag}]")));
                            } else if line == "drop" {
                                send(&mut ws, done);
                                let _ = ws.get_mut().shutdown(std::net::Shutdown::Both);
                                return;
                            } else {
                                send(
                                    &mut ws,
                                    json!({"kind": "room", "timestamp": 0, "command_request_id": id, "data": {"text": "Start"}}),
                                );
                                send(&mut ws, done);
                            }
                        }
                        _ => {}
                    }
                }
            });
        }
    });
    (url, log)
}

#[test]
fn tell_and_await_prefers_the_tagged_reply_and_skips_notices() {
    let (url, _) = ws_server();
    let connection = Connection::new(&url, "agent", None).unwrap();
    connection.login("rs").unwrap();
    let reply = connection
        .tell_and_await("Peer", "ping", Duration::from_secs(5))
        .unwrap();
    assert_eq!(reply, "pong");
    let strict = TellAwaitOptions {
        timeout: Duration::from_secs(5),
        strict_correlation: true,
        ..Default::default()
    };
    assert_eq!(
        connection
            .tell_and_await_with("Peer", "ping", &strict)
            .unwrap(),
        "pong"
    );
    match connection.wait_for_tell(Some("Nobody"), Duration::from_millis(100)) {
        Err(Error::Timeout(_)) => {}
        other => panic!("expected a timeout, got {other:?}"),
    }
    connection.close();
}

#[test]
fn a_dropped_socket_resumes_with_the_newest_token_and_close_never_reconnects() {
    let (url, log) = ws_server();
    let connection = Connection::new(&url, "agent", None).unwrap();
    assert_eq!(connection.login("rs").unwrap().token, "t1");
    let resumed: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = resumed.clone();
    connection.on_reconnect(move |s| seen.lock().unwrap().push(s.token.clone()));
    let closed = Arc::new(Mutex::new(false));
    let flag = closed.clone();
    connection.add_close(move || *flag.lock().unwrap() = true);
    connection.command("drop").unwrap();
    let start = std::time::Instant::now();
    while connection.is_connected() && start.elapsed() < Duration::from_secs(2) {
        thread::sleep(Duration::from_millis(10));
    }
    // Disconnected: a command fails at once, it is not queued.
    match connection.command("look") {
        Err(Error::ConnectionLost(_)) => {}
        other => panic!("expected ConnectionLost, got {other:?}"),
    }
    while resumed.lock().unwrap().is_empty() && start.elapsed() < Duration::from_secs(10) {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(*resumed.lock().unwrap(), ["t2"]);
    assert!(
        start.elapsed() >= Duration::from_millis(2900),
        "waited the first backoff"
    );
    assert_eq!(connection.session().unwrap().token, "t2");
    assert!(!*closed.lock().unwrap(), "a resumed session is not closed");
    assert_eq!(connection.command("look").unwrap().text(), "Start");
    {
        let log = log.lock().unwrap();
        let auth: Vec<&Value> = log.iter().filter(|v| v["type"] == "auth").collect();
        assert_eq!(auth.len(), 1);
        assert_eq!(auth[0]["token"], "t1");
        assert_eq!(auth[0]["principal"], "agent");
    }
    connection.close();
    assert!(*closed.lock().unwrap());
    assert!(connection.is_closed());
    thread::sleep(Duration::from_millis(200));
    let logins = log
        .lock()
        .unwrap()
        .iter()
        .filter(|v| v["type"] == "auth" || v["type"] == "login")
        .count();
    assert_eq!(logins, 2, "close() never reconnects");
}

// ─── Typed command forms ───────────────────────────────────────────────────

fn form(v: Value) -> CommandForm {
    serde_json::from_value(v).unwrap()
}

fn values(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn compose_fills_a_form_with_the_typescript_rules() {
    let say = form(json!({
        "syntax": "say <message>", "label": "say <message>", "groups": [],
        "fields": [{"id": "field-0", "label": "message", "placeholder": "message", "kind": "text", "multiline": true, "allowNewlines": false}],
        "parts": [{"literal": "say"}, {"field": "field-0"}]
    }));
    let none: HashMap<String, bool> = HashMap::new();
    let missing = compose_command(&say, &HashMap::new(), &none);
    assert_eq!(
        missing.errors.get("field-0").map(String::as_str),
        Some("Required")
    );
    let by_id = compose_command(&say, &values(&[("field-0", "  hello there ")]), &none);
    assert_eq!(by_id.command, "say hello there");
    assert!(by_id.errors.is_empty());
    let by_label = compose_command(&say, &values(&[("message", "hi")]), &none);
    assert_eq!(by_label.command, "say hi");
    let lines = compose_command(&say, &values(&[("message", "a\nb")]), &none);
    assert_eq!(lines.errors["field-0"], "Use a single line");

    let spawn = form(json!({
        "syntax": "agent spawn <name> [role:<role>] [n:<count>] [mode:<a|b>] [<json>]", "label": "x",
        "fields": [
            {"id": "field-0", "label": "name", "placeholder": "name", "kind": "text", "multiline": false, "allowNewlines": false},
            {"id": "field-1", "label": "role", "placeholder": "role", "optionalGroup": "option-0", "kind": "text", "multiline": false, "allowNewlines": false},
            {"id": "field-2", "label": "n", "placeholder": "count", "optionalGroup": "option-1", "kind": "number", "multiline": false, "allowNewlines": false, "min": 1, "max": 5, "integer": true},
            {"id": "field-3", "label": "mode", "placeholder": "a|b", "optionalGroup": "option-2", "kind": "choice", "choices": ["a", "b"], "multiline": false, "allowNewlines": false},
            {"id": "field-4", "label": "json", "placeholder": "json", "optionalGroup": "option-3", "kind": "json", "multiline": true, "allowNewlines": false}
        ],
        "groups": [{"id": "option-0", "label": "role:role"}, {"id": "option-1", "label": "n:count"}, {"id": "option-2", "label": "mode"}, {"id": "option-3", "label": "json"}],
        "parts": [
            {"literal": "agent"}, {"literal": "spawn"}, {"field": "field-0"},
            {"group": "option-0", "children": [{"literal": "role:"}, {"field": "field-1"}]},
            {"group": "option-1", "children": [{"literal": "n:"}, {"field": "field-2"}]},
            {"group": "option-2", "children": [{"literal": "mode:"}, {"field": "field-3"}]},
            {"group": "option-3", "children": [{"field": "field-4"}]}
        ]
    }));
    let all = HashMap::from([
        ("option-0".to_string(), true),
        ("option-1".to_string(), true),
        ("option-2".to_string(), true),
        ("option-3".to_string(), true),
    ]);
    let good = compose_command(
        &spawn,
        &values(&[
            ("field-0", "bob"),
            ("role", "coder"),
            ("field-2", "3"),
            ("field-3", "b"),
            ("field-4", "{ \"b\": 1, \"a\": [1, 2] }"),
        ]),
        &all,
    );
    assert!(good.errors.is_empty(), "{:?}", good.errors);
    assert_eq!(
        good.command,
        r#"agent spawn bob role:coder n:3 mode:b {"b":1,"a":[1,2]}"#
    );
    let only_name = compose_command(&spawn, &values(&[("field-0", "bob")]), &none);
    assert_eq!(only_name.command, "agent spawn bob");
    assert!(
        only_name.errors.is_empty(),
        "disabled groups are not checked"
    );
    let bad = compose_command(
        &spawn,
        &values(&[
            ("field-0", "two words"),
            ("field-1", "x"),
            ("field-2", "9"),
            ("field-3", "c"),
            ("field-4", "{nope"),
        ]),
        &all,
    );
    assert_eq!(bad.errors["field-0"], "Use one value without spaces");
    assert_eq!(bad.errors["field-2"], "Enter a number between 1 and 5");
    assert_eq!(bad.errors["field-3"], "Choose one of the available values");
    assert_eq!(bad.errors["field-4"], "Enter valid JSON");
    for (text, error) in [
        ("abc", "Enter a number"),
        ("2.5", "Enter an integer"),
        ("inf", "Enter a number"),
    ] {
        let r = compose_command(
            &spawn,
            &values(&[("field-0", "b"), ("field-2", text)]),
            &HashMap::from([("option-1".to_string(), true)]),
        );
        assert_eq!(r.errors["field-2"], error, "{text}");
    }
    let hex = compose_command(
        &spawn,
        &values(&[("field-0", "b"), ("field-2", "0x3")]),
        &HashMap::from([("option-1".to_string(), true)]),
    );
    assert!(hex.errors.is_empty(), "Number(\"0x3\") is 3");
    let mut named = say.clone();
    named.encoding = Some("named".into());
    let refused = compose_command(&named, &values(&[("message", "hi")]), &none);
    assert_eq!(refused.command, "");
    assert!(refused.errors.contains_key("form"));
}

// ─── Memory retry ──────────────────────────────────────────────────────────

fn api(status: u16, code: &str, retry_after_ms: Option<u64>) -> Error {
    Error::Api {
        status,
        code: code.into(),
        message: String::new(),
        retry_after_ms,
    }
}

/// Run `retry_memory` over a scripted list of failures (then success); return the waits.
fn retried(failures: Vec<Error>, attempts: u32) -> (marina_sdk::Result<u32>, Vec<u64>) {
    let mut queue = std::collections::VecDeque::from(failures);
    let mut calls = 0;
    let mut waits = Vec::new();
    let out = retry_memory(
        || {
            calls += 1;
            match queue.pop_front() {
                Some(e) => Err(e),
                None => Ok(calls),
            }
        },
        attempts,
        |d| waits.push(d.as_millis() as u64),
    );
    (out, waits)
}

#[test]
fn memory_retry_follows_the_typescript_rules() {
    // A named rate limit is waited out exactly (+5 ms) and uses no attempt.
    let (out, waits) = retried(vec![api(429, "rate_limited", Some(100)); 6], 2);
    assert_eq!(out.unwrap(), 7);
    assert_eq!(waits, [105; 6]);
    // ... up to 30 s of such waits in all.
    let (out, waits) = retried(vec![api(429, "rate_limited", Some(5000)); 7], 5);
    assert!(matches!(out, Err(Error::Api { status: 429, .. })));
    assert_eq!(waits.len(), 5);
    // Other transient failures back off 250 ms doubling to 2 s; attempts are tries.
    let (out, waits) = retried(vec![api(503, "x", None); 6], 5);
    assert!(out.is_err());
    assert_eq!(waits, [250, 500, 1000, 2000]);
    let (out, waits) = retried(
        vec![
            api(502, "x", None),
            api(504, "x", Some(900)),
            Error::Transport("down".into()),
            api(408, "x", None),
        ],
        10,
    );
    assert_eq!(out.unwrap(), 5);
    assert_eq!(waits, [250, 900, 1000, 2000]);
    // A 429 without the name is an ordinary retry.
    let (_, waits) = retried(vec![api(429, "busy", None)], 5);
    assert_eq!(waits, [250]);
    // A server wait over 5 s is the caller's; other errors are never retried.
    let (out, waits) = retried(vec![api(503, "x", Some(6000))], 5);
    assert!(out.is_err() && waits.is_empty());
    let (out, waits) = retried(vec![api(409, "conflict", None)], 5);
    assert!(out.is_err() && waits.is_empty());
    let (out, _) = retried(vec![], 0);
    assert!(matches!(out, Err(Error::Invalid(_))));
    assert_eq!(marina_sdk::retry::memory_backoff(9).as_millis(), 2000);
}

// ─── Generated models ──────────────────────────────────────────────────────

#[test]
fn generated_models_round_trip_with_the_wire_names() {
    use marina_sdk::models::{MemoryRecordInput, RoutingMessage, RoutingSession};
    let wire = json!({
        "id": "s1", "ownerId": "o", "clientKey": "k", "label": "A", "kind": "service",
        "groupId": null, "capabilities": ["x"], "state": "active",
        "createdAt": 1.5, "lastSeenAt": 2.5, "lastSequence": 3.5, "newerField": true
    });
    let session: RoutingSession = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(session.client_key, "k");
    assert_eq!(session.group_id, None);
    let mut back = serde_json::to_value(&session).unwrap();
    back.as_object_mut()
        .unwrap()
        .insert("newerField".into(), json!(true));
    assert_eq!(
        back, wire,
        "renamed fields and a required null survive; unknown fields are ignored"
    );
    let input = MemoryRecordInput {
        content: "x".into(),
        ..Default::default()
    };
    assert_eq!(
        serde_json::to_value(&input).unwrap(),
        json!({"content": "x"}),
        "None is left out"
    );
    let message: RoutingMessage = serde_json::from_value(
        json!({"id": "m", "payload": {"a": 1}, "status": "queued", "acknowledgedAt": null}),
    )
    .unwrap();
    assert_eq!(message.payload, json!({"a": 1}));
    assert_eq!(message.acknowledged_at, None);
}

#[test]
fn typed_calls_send_their_parameters() {
    let (base, seen) = server();
    let routing = RoutingApi::new(HttpApi::new(&base, || "tok".into(), Some("routing")));
    let _ = routing.events("s 1", Some(10.0), None); // the fake replies {"ok":true}: not a page
    let memory = MemoryApi::new(HttpApi::new(&base, || "cred".into(), Some("memory")));
    let input = marina_sdk::models::MemoryRecordInput {
        content: "x".into(),
        ..Default::default()
    };
    let _ = memory.remember("sp", &input, Some("k9"));
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].path, "/api/routing/sessions/s%201/events?after=10");
    assert_eq!(seen[1].path, "/v1/memory/spaces/sp/records");
    assert_eq!(seen[1].header("idempotency-key"), Some("k9"));
    assert_eq!(
        serde_json::from_str::<Value>(&seen[1].body).unwrap(),
        json!({"content": "x"})
    );
    // Deref keeps the generic call.
    assert!(
        routing
            .operations()
            .iter()
            .any(|o| o.name == "join_session")
    );
}

#[test]
fn panel_stream_messages_are_hints() {
    use marina_sdk::panel_events::read_panel_message;
    assert_eq!(
        read_panel_message(r#"{"type":"snapshot","data":{}}"#),
        Some(None)
    );
    let event = read_panel_message(
        r#"{"type":"event","data":{"type":"canvas_node_created","canvasId":"c1","taskId":4}}"#,
    )
    .unwrap()
    .unwrap();
    assert_eq!(event.r#type, "canvas_node_created");
    assert_eq!(event.canvas_id.as_deref(), Some("c1"));
    assert_eq!(event.task_id, Some(4.0));
    assert_eq!(read_panel_message(r#"{"type":"event","data":{}}"#), None);
    assert_eq!(read_panel_message("not json"), None);
}
