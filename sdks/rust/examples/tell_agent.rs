// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! An agent that answers tells: whoever tells it something gets an answer back. It keeps its
//! session across dropped sockets on its own.
//!
//!   cargo run --example tell_agent -- ws://localhost:3300 helper
//!
//! Ask it from another session: `tell helper what time is it` (or `tell_and_await`). A
//! correlation tag in the question (`[re:<id>]`) is echoed so the asker matches the answer.

use marina_sdk::{Marina, is_tell_notice, tell_of};
use std::sync::mpsc;

fn main() -> marina_sdk::Result<()> {
    let mut args = std::env::args().skip(1);
    let url = args.next().unwrap_or_else(|| "ws://localhost:3300".into());
    let name = args.next().unwrap_or_else(|| "helper".into());
    let marina = Marina::connect(&url, &name)?;
    println!("Listening as {}.", marina.session()?.name);
    marina.on_reconnect(|session| eprintln!("Reconnected as {}.", session.name));

    // Listeners run on an SDK thread; answer on this one.
    let (tx, rx) = mpsc::channel::<(String, String)>();
    marina.on_event(move |frame| {
        if let Some((from, text)) = tell_of(frame)
            && !is_tell_notice(&text)
        {
            let _ = tx.send((from, text)); // main has stopped: nothing to answer
        }
    });
    for (from, text) in rx {
        let tag = text.find("[re:").and_then(|at| {
            text[at..]
                .find(']')
                .map(|end| text[at..=at + end].to_string())
        });
        let question = match &tag {
            Some(t) => text.replace(t, "").trim().to_string(),
            None => text.clone(),
        };
        if question == "stop" {
            break;
        }
        let answer = format!("You said: {question}");
        let reply = match tag {
            Some(t) => format!("{answer} {t}"),
            None => answer,
        };
        if let Err(e) = marina.tell(&from, &reply) {
            eprintln!("Could not answer {from}: {e}");
        }
    }
    marina.close();
    Ok(())
}
