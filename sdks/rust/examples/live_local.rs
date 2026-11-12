// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! Live: Marina::local from Rust. Driven by test/rust-sdk.test.ts. args: folder, then the marina
//! command as JSON. The test sets HOME and blank provider keys.

use marina_sdk::{Error, LocalOptions, Marina, RunOptions};
use serde_json::{Map, json};
use std::path::Path;

fn alive(pid: u64) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

fn main() -> marina_sdk::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let folder = Path::new(&args[1]);
    let command: Vec<String> = serde_json::from_str(&args[2]).expect("command JSON");
    let options = LocalOptions {
        fresh: true,
        command,
        ..Default::default()
    };
    let mut report = Map::new();
    let pid;
    {
        let marina = Marina::local_with(folder, &options)?;
        report.insert("name".into(), json!(marina.session()?.name));
        pid = marina.server_pid().unwrap_or(0);
        report.insert("alive".into(), json!(alive(pid)));
        if let Err(e @ Error::Command { .. }) =
            marina.code().run("Add a README", RunOptions::default())
        {
            report.insert("refused".into(), json!(e.to_string()));
        }
        report.insert(
            "look".into(),
            json!(!marina.command("look")?.frames.is_empty()),
        );
    } // dropped: closes and stops the server
    report.insert("stopped".into(), json!(!alive(pid)));
    if let Err(e) = Marina::local_with(folder.join("missing"), &options) {
        report.insert("missing".into(), json!(e.to_string()));
    }
    println!("{}", serde_json::Value::Object(report));
    Ok(())
}
