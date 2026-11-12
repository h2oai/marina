// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! The Rust SDK's conformance driver (protocol/conformance.md), run by
//! test/sdk-conformance.test.ts:
//!
//!   conformance <scenario> <server url> '<args JSON>'
//!
//! It prints `{"ready": ...}` when the test must act, reads one `{"go": ...}` line, and ends with
//! `{"report": ...}` (or `{"error": ...}` and a non-zero exit).

use marina_sdk::models::{
    AcknowledgeMessageRequest, CreateSpaceRequest, MemoryRecordInput, MemorySearchInput,
    PublishRequest, RoutingEventInput, RoutingJoin, RoutingSend,
};
use marina_sdk::{
    Error, Kind, LocalOptions, Marina, Result, RunOptions, Verdict, Verification, classify,
    compose_command, retry_memory,
};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::BufRead;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

fn emit(line: Value) {
    println!("{line}");
}

/// Tell the test we are waiting, then wait for its "go" line.
fn ready(info: Value) -> Value {
    emit(json!({ "ready": info }));
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).ok();
    serde_json::from_str::<Value>(&line)
        .ok()
        .and_then(|v| v.get("go").cloned())
        .unwrap_or(json!({}))
}

fn until(check: impl Fn() -> bool, within: Duration) -> bool {
    let end = Instant::now() + within;
    while !check() && Instant::now() < end {
        thread::sleep(Duration::from_millis(20));
    }
    check()
}

fn texts(result: &marina_sdk::CommandResult) -> String {
    result
        .frames
        .iter()
        .map(marina_sdk::wire::text_of)
        .collect::<Vec<_>>()
        .join("\n")
}

struct Context {
    url: String,
    name: String,
    args: Value,
}

fn coding(c: &Context) -> Result<Value> {
    let marina = Marina::connect(&c.url, &c.name)?;
    ready(json!({ "entity": marina.session()?.entity_id }));
    let frames: Arc<Mutex<Vec<Value>>> = Arc::default();
    let collected = frames.clone();
    marina.on_event(move |f| {
        if classify(f) == Kind::Code {
            collected.lock().unwrap().push(Value::Object(f.clone()));
        }
    });
    let options = RunOptions {
        verification: Verification::Candidate,
        timeout: Duration::from_secs(120),
        ..Default::default()
    };
    let run = marina
        .code()
        .run(c.args["task"].as_str().unwrap_or(""), options)?;
    let events: Vec<_> = run.events().collect();
    let result = run.result()?;
    let steps: Vec<Value> = events
        .iter()
        .filter_map(|e| e.activity.as_ref())
        .map(|a| serde_json::to_value(a).unwrap_or(Value::Null))
        .collect();
    let report = json!({
        "run_id": run.run_id(),
        "result": Value::Object(result.raw.clone()),
        "typed_result": serde_json::to_value(&result).unwrap_or(Value::Null),
        "submitted": result.submitted(),
        "summary": result.summary,
        "steps": steps,
        "last_event_run": events.last().and_then(|e| e.result.as_ref()).map(|r| r.run_id.clone()),
        "diff": marina.code().diff(None)?,
        "frames": frames.lock().unwrap().clone(),
    });
    marina.code().review(&result.run_id, Verdict::Approve)?;
    marina.close();
    Ok(report)
}

fn commands(c: &Context) -> Result<Value> {
    let marina = Marina::connect(&c.url, &c.name)?;
    let look = texts(&marina.command("look")?);
    let refused = match marina.command("frobnicate the moon") {
        Err(e) => e.to_string(),
        Ok(_) => String::new(),
    };
    let manifest = marina.capability_manifest()?;
    let form = manifest
        .command("say")
        .and_then(|say| say.forms.iter().find(|f| f.syntax.starts_with("say ")))
        .ok_or_else(|| Error::Other("no say form".into()))?;
    let field = form
        .fields
        .iter()
        .find(|f| f.label == "message")
        .or(form.fields.first())
        .ok_or_else(|| Error::Other("the say form has no field".into()))?;
    let none = HashMap::new();
    let missing = compose_command(form, &HashMap::new(), &none);
    let values = HashMap::from([(field.id.clone(), format!("hello from {}", c.name))]);
    let composed = compose_command(form, &values, &none);
    let said = texts(&marina.command(&composed.command)?);
    marina.close();
    Ok(json!({
        "look": look,
        "refused": refused,
        "capability_count": manifest.commands.len(),
        "composed": composed.command,
        "missing_errors": missing.errors.len(),
        "said": said,
    }))
}

fn reconnect(c: &Context) -> Result<Value> {
    let marina = Marina::connect(&c.url, &c.name)?;
    let before = marina.session()?;
    let reconnects = Arc::new(AtomicUsize::new(0));
    let counter = reconnects.clone();
    marina.on_reconnect(move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    ready(json!({ "entity": before.entity_id }));
    let back = until(
        || reconnects.load(Ordering::SeqCst) > 0 && marina.is_connected(),
        Duration::from_secs(30),
    );
    let look = back && !marina.command("look")?.frames.is_empty();
    let after = marina.session()?;
    marina.close();
    Ok(json!({
        "reconnected": back,
        "same_entity": after.entity_id == before.entity_id,
        "token_changed": after.token != before.token,
        "look_ok": look,
    }))
}

fn agent(c: &Context) -> Result<Value> {
    let marina = Marina::connect(&c.url, &c.name)?;
    let peer = c.args["peer"].as_str().unwrap_or("Peer");
    let reply = marina.tell_and_await(peer, "ping", Duration::from_secs(15))?;
    ready(json!({ "listening": true }));
    let heard = marina.wait_for_tell(Some(peer), Duration::from_secs(15))?;
    marina.tell(peer, &format!("answer: {heard}"))?;
    marina.close();
    Ok(json!({ "reply": reply, "heard": heard }))
}

fn memory(c: &Context) -> Result<Value> {
    let marina = Marina::connect(&c.url, &c.name)?;
    let memory = marina.memory(c.args["credential"].as_str().unwrap_or(""));
    let space = memory
        .create_space(
            &CreateSpaceRequest {
                name: format!("{}-space", c.name),
            },
            None,
        )?
        .id;
    let note = MemoryRecordInput {
        content: "Deploys run from main".into(),
        ..Default::default()
    };
    let first = memory.remember(&space, &note, Some("conf-1"))?;
    let again = memory.remember(&space, &note, Some("conf-1"))?;
    let record = memory.get(&space, &first.id, None)?;
    let found = memory.search(
        &space,
        &MemorySearchInput {
            query: "deploy".into(),
            ..Default::default()
        },
    )?;
    let count = c.args["burst"].as_u64().unwrap_or(140);
    let waits = AtomicUsize::new(0);
    for i in 0..count {
        let input = MemoryRecordInput {
            content: format!("note {i}"),
            ..Default::default()
        };
        // One key per record: a retry can never write it twice.
        let key = format!("{}-burst-{i}", c.name);
        retry_memory(
            || memory.remember(&space, &input, Some(&key)),
            5,
            |wait| {
                waits.fetch_add(1, Ordering::SeqCst);
                thread::sleep(wait);
            },
        )?;
    }
    marina.close();
    Ok(json!({
        "space": space,
        "receipt_id": first.id,
        "replayed": first.id == again.id && first.version == again.version,
        "content": record.content,
        "found": serde_json::to_string(&found).unwrap_or_default().contains("Deploys run from main"),
        "written": count,
        "rate_limit_waits": waits.load(Ordering::SeqCst),
    }))
}

fn panels(c: &Context) -> Result<Value> {
    let marina = Marina::connect(&c.url, &c.name)?;
    let seen: Arc<Mutex<Vec<marina_sdk::PanelChangeEvent>>> = Arc::default();
    let snapshot = Arc::new(AtomicBool::new(false));
    let (events, snapped) = (seen.clone(), snapshot.clone());
    let mut watch = marina.watch_changes(
        move |event| {
            events.lock().unwrap().push(event.clone());
        },
        move || snapped.store(true, Ordering::SeqCst),
    );
    until(|| snapshot.load(Ordering::SeqCst), Duration::from_secs(10));
    marina.command(&format!("canvas create {}board", c.name))?;
    marina.command(&format!(
        "canvas post on:{}board hello from {}",
        c.name, c.name
    ))?;
    let got = until(
        || seen.lock().unwrap().iter().any(|e| e.canvas_id.is_some()),
        Duration::from_secs(10),
    );
    watch.stop();
    marina.close();
    let mut types: Vec<String> = Vec::new();
    for event in seen.lock().unwrap().iter() {
        if !types.contains(&event.r#type) {
            types.push(event.r#type.clone());
        }
    }
    Ok(json!({
        "snapshot": snapshot.load(Ordering::SeqCst),
        "got_canvas_event": got,
        "event_types": types,
    }))
}

fn routing(c: &Context) -> Result<Value> {
    let marina = Marina::connect(&c.url, &c.name)?;
    let routing = marina.routing();
    let join = |key: &str, label: &str| {
        routing.join_session(&RoutingJoin {
            client_key: format!("{}-{key}", c.name),
            label: label.into(),
            kind: "service".into(),
            ..Default::default()
        })
    };
    let a = join("a", "A")?;
    let b = join("b", "B")?;
    routing.publish(
        &a.id,
        &PublishRequest {
            events: vec![RoutingEventInput {
                id: "e1".into(),
                kind: "output".into(),
                payload: json!({ "text": "hello" }),
            }],
        },
    )?;
    let sent = routing.send(
        &a.id,
        &RoutingSend {
            client_message_id: "m1".into(),
            target_id: b.id.clone(),
            kind: "note".into(),
            payload: json!("hi"),
        },
    )?;
    let inbox = routing.inbox(&b.id, None)?;
    routing.acknowledge_message(&b.id, &sent.id, &AcknowledgeMessageRequest {})?;
    let events = routing.events(&a.id, None, None)?;
    marina.close();
    Ok(json!({
        "session_a": a.id,
        "inbox_has_message": inbox.messages.iter().any(|m| m.id == sent.id),
        "published": serde_json::to_string(&events).unwrap_or_default().contains("hello"),
    }))
}

fn alive(pid: u64) -> bool {
    if Path::new("/proc").is_dir() {
        return Path::new(&format!("/proc/{pid}")).exists();
    }
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn local(c: &Context) -> Result<Value> {
    let folder = c.args["folder"].as_str().unwrap_or("").to_string();
    let command: Vec<String> = serde_json::from_value(c.args["command"].clone())
        .map_err(|e| Error::Invalid(format!("args.command: {e}")))?;
    let options = LocalOptions {
        fresh: true,
        command,
        ..Default::default()
    };
    let marina = Marina::local_with(&folder, &options)?;
    let pid = marina.server_pid().unwrap_or(0);
    let refused = match marina.code().run("Add a README", RunOptions::default()) {
        Err(e) => e.to_string(),
        Ok(_) => String::new(),
    };
    let look = !marina.command("look")?.frames.is_empty();
    let name = marina.session()?.name;
    marina.close();
    let stopped = pid > 0 && !alive(pid);
    let missing = match Marina::local_with(Path::new(&folder).join("missing"), &options) {
        Err(e) => e.to_string(),
        Ok(m) => {
            m.close();
            String::new()
        }
    };
    Ok(
        json!({ "name": name, "refused": refused, "look": look, "stopped": stopped, "missing": missing }),
    )
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let scenario = argv.get(1).cloned().unwrap_or_default();
    let args: Value = argv
        .get(3)
        .and_then(|a| serde_json::from_str(a).ok())
        .unwrap_or(json!({}));
    let context = Context {
        url: argv.get(2).cloned().unwrap_or_default(),
        name: args["name"].as_str().unwrap_or("rsdriver").to_string(),
        args,
    };
    let run: fn(&Context) -> Result<Value> = match scenario.as_str() {
        "coding" => coding,
        "commands" => commands,
        "reconnect" => reconnect,
        "agent" => agent,
        "memory" => memory,
        "panels" => panels,
        "routing" => routing,
        "local" => local,
        other => {
            emit(json!({ "error": format!("unknown scenario {other}") }));
            std::process::exit(1);
        }
    };
    match run(&context) {
        Ok(report) => {
            let mut line = Map::new();
            line.insert("report".into(), report);
            emit(Value::Object(line));
        }
        Err(e) => {
            emit(json!({ "error": e.to_string() }));
            std::process::exit(1);
        }
    }
}
