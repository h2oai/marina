// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! Live: a coding run through the Rust SDK. Driven by test/rust-sdk.test.ts.
//!
//! args: server url, task, memory credential. Prints {"entity": ...}, waits for a line on stdin
//! (the test grants code.exec), then prints one JSON report.

use marina_sdk::{
    ConnectOptions, Error, Kind, Marina, RunOptions, Verdict, Verification, classify,
};
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn main() -> marina_sdk::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (url, task, credential) = (&args[1], &args[2], &args[3]);
    let marina = Marina::connect(url, "rsbuilder")?;
    println!("{}", json!({ "entity": marina.session()?.entity_id }));
    std::io::stdin().read_line(&mut String::new()).ok();

    let frames: Arc<Mutex<Vec<Value>>> = Arc::default();
    let collected = frames.clone();
    marina.on_event(move |f| {
        if classify(f) == Kind::Code {
            collected.lock().unwrap().push(Value::Object(f.clone()));
        }
    });
    let mut report = Map::new();
    if let Err(Error::Invalid(m)) = marina.code().run("   ", RunOptions::default()) {
        report.insert("empty".into(), json!(m));
    }
    let options = RunOptions {
        verification: Verification::Candidate,
        timeout: Duration::from_secs(120),
        ..Default::default()
    };
    let run = marina.code().run(task, options)?;
    let events: Vec<_> = run.events().collect();
    let result = run.result()?;
    report.insert("run_id".into(), json!(run.run_id()));
    report.insert("result".into(), Value::Object(result.raw.clone()));
    report.insert("typed".into(), serde_json::to_value(&result).unwrap());
    report.insert("submitted".into(), json!(result.submitted()));
    report.insert("summary".into(), json!(result.summary));
    let steps: Vec<Value> = events
        .iter()
        .filter_map(|e| e.activity.as_ref())
        .map(|a| serde_json::to_value(a).unwrap())
        .collect();
    report.insert("steps".into(), json!(steps));
    report.insert(
        "last_event_run".into(),
        json!(
            events
                .last()
                .and_then(|e| e.result.as_ref())
                .map(|r| r.run_id.clone())
        ),
    );
    report.insert("diff".into(), json!(marina.code().diff(None)?));
    marina.code().review(&result.run_id, Verdict::Approve)?;
    report.insert("look".into(), json!(marina.command("look")?.text()));
    if let Err(e @ Error::Command { .. }) = marina.command("frobnicate the moon") {
        report.insert("refused".into(), json!(e.to_string()));
    }
    report.insert(
        "discover".into(),
        marina.routing().call("discover", &[], None)?,
    );
    let capabilities = marina.capabilities()?;
    report.insert(
        "capability_count".into(),
        json!(capabilities["commands"].as_array().map(Vec::len)),
    );

    let memory = marina.memory(credential);
    let space = memory.call("create_space", &[], Some(json!({ "name": "rsspace" })))?["id"].clone();
    let note = json!({ "content": "Deploys run from main" });
    let first = memory.call_with_key(
        "remember",
        &[("space", space.clone())],
        Some(note.clone()),
        Some("rs-1"),
    )?;
    let again = memory.call_with_key(
        "remember",
        &[("space", space.clone())],
        Some(note),
        Some("rs-1"),
    )?;
    let found = memory.call(
        "search",
        &[("space", space)],
        Some(json!({ "query": "deploy" })),
    )?;
    report.insert(
        "memory".into(),
        json!({ "replayed": first == again, "found": found.to_string().contains("Deploys run from main") }),
    );

    let (entity, token) = (marina.session()?.entity_id, marina.token()?);
    marina.close();
    let resumed = Marina::connect_with(url, ConnectOptions::token(&token))?;
    report.insert(
        "resumed".into(),
        json!({ "same": resumed.session()?.entity_id == entity, "new_token": resumed.token()? != token }),
    );
    resumed.close();
    report.insert("frames".into(), json!(frames.lock().unwrap().clone()));
    println!("{}", Value::Object(report));
    Ok(())
}
