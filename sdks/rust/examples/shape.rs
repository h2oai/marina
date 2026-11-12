// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! Prints the SDK's coding shapes (every optional field set), for test/rust-sdk.test.ts to hold
//! against the wire schema.

use marina_sdk::*;
use serde_json::{Map, json};

fn main() {
    let activity = CodingActivity {
        kind: "edit".into(),
        label: "l".into(),
        path: Some("p".into()),
        diff: Some(vec![]),
        more: Some(0),
        quiet: Some(false),
    };
    let s = || Some("x".to_string());
    let result = RunResult {
        run_id: "r".into(),
        terminal: true,
        phase: "completed".into(),
        task_id: Some(1),
        agent: s(),
        outcome: s(),
        reason: s(),
        detail: s(),
        summary: s(),
        summary_id: s(),
        verification: s(),
        verification_reason: s(),
        budget_forced: Some(BudgetForced {
            reason: "x".into(),
            used: None,
            cap: None,
        }),
        raw: Map::new(),
    };
    let keys = |v: serde_json::Value| {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    println!(
        "{}",
        json!({
            "activity": keys(serde_json::to_value(&activity).unwrap()),
            "result": keys(serde_json::to_value(&result).unwrap()),
            "kinds": CODING_ACTIVITY_KINDS, "verifications": VERIFICATIONS, "outcomes": RUN_OUTCOMES,
            "protocol": WIRE_PROTOCOL,
        })
    );
}
