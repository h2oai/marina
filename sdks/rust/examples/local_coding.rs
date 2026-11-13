// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! A coding program: start the folder's own Marina, run one task, show its steps and change.
//!
//!   cargo run --example local_coding -- <folder> "<task>"
//!
//! Needs the `marina` CLI on PATH and a model provider (`marina setup`).

use marina_sdk::{Marina, RunOptions, Verdict};
use std::time::Duration;

fn main() -> marina_sdk::Result<()> {
    let mut args = std::env::args().skip(1);
    let folder = args.next().unwrap_or_else(|| ".".into());
    let task = args
        .next()
        .unwrap_or_else(|| "Add a short README that says what this folder is".into());
    // Dropping `marina` (or `close()`) stops the server it started.
    let marina = Marina::local(&folder)?;
    let options = RunOptions {
        budget: Some(Duration::from_secs(10 * 60)),
        ..Default::default()
    };
    let run = marina.code().run(&task, options)?;
    for step in run.steps() {
        println!("  {}", step.label);
    }
    let result = run.result()?;
    println!(
        "{}: {}",
        result.outcome.as_deref().unwrap_or(&result.phase),
        result.summary.as_deref().unwrap_or("")
    );
    if result.submitted() {
        println!("{}", marina.code().diff(None)?);
        if result.verified() {
            marina.code().review(&result.run_id, Verdict::Approve)?;
            println!("Approved: the checks passed.");
        } else {
            println!(
                "Not approved: checks did not pass ({:?}).",
                result.verification
            );
        }
    }
    marina.close();
    Ok(())
}
