// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! `marina.http.v1`: memory, routing, investigations and panels over HTTP.
//!
//! Every operation in protocol/marina.http.v1.openapi.json is called by its operation id or its
//! snake_case name, with path and query parameters by name and the JSON body:
//!
//! ```no_run
//! # fn demo(marina: &marina_sdk::Marina, credential: &str) -> marina_sdk::Result<()> {
//! use serde_json::json;
//! marina.routing().call("discover", &[], None)?;
//! let memory = marina.memory(credential);
//! let space = memory.call("create_space", &[], Some(json!({ "name": "notes" })))?["id"].clone();
//! memory.call("remember", &[("space", space)], Some(json!({ "content": "Deploys run from main" })))?;
//! # Ok(()) }
//! ```

use crate::error::{Error, Result};
use crate::operations::{OPERATIONS, Operation, find};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

type Token = Arc<dyn Fn() -> String + Send + Sync>;

/// The operations of one group (`memory`, `routing`, ...), or of all.
#[derive(Clone)]
pub struct HttpApi {
    base_url: String,
    token: Token,
    tag: Option<String>,
    agent: ureq::Agent,
}

fn encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn as_param(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

impl HttpApi {
    /// The operations of `tag` (or all, with `None`), signed with `token`.
    pub fn new(
        base_url: &str,
        token: impl Fn() -> String + Send + Sync + 'static,
        tag: Option<&str>,
    ) -> HttpApi {
        let agent = ureq::Agent::config_builder()
            // Never follows a redirect: it would carry the bearer token somewhere else.
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(35)))
            .build()
            .new_agent();
        HttpApi {
            base_url: base_url.trim_end_matches('/').to_string(),
            token: Arc::new(token),
            tag: tag.map(str::to_string),
            agent,
        }
    }

    /// The operations this group offers.
    pub fn operations(&self) -> Vec<&'static Operation> {
        OPERATIONS
            .iter()
            .filter(|op| self.tag.as_deref().is_none_or(|t| t == op.tag))
            .collect()
    }

    /// Call an operation. `params` are path and query parameters by name.
    pub fn call(
        &self,
        operation: &str,
        params: &[(&str, Value)],
        body: Option<Value>,
    ) -> Result<Value> {
        self.call_with_key(operation, params, body, None)
    }

    /// Call an operation with your own `Idempotency-Key` (memory writes): the same key replays the
    /// first result, so a retry with it is safe. Without one, a fresh key is made.
    pub fn call_with_key(
        &self,
        operation: &str,
        params: &[(&str, Value)],
        body: Option<Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value> {
        let op = find(operation)
            .filter(|op| self.tag.as_deref().is_none_or(|t| t == op.tag))
            .ok_or_else(|| {
                Error::Invalid(format!("No operation {operation} here; see operations()"))
            })?;
        let mut rest: Vec<(&str, &Value)> = params.iter().map(|(k, v)| (*k, v)).collect();
        let mut take = |name: &str| -> Option<Value> {
            let i = rest.iter().position(|(k, _)| *k == name)?;
            Some(rest.remove(i).1.clone())
        };
        let mut path = op.path.to_string();
        for name in op.path_params {
            let value = take(name)
                .filter(|v| !v.is_null())
                .ok_or_else(|| Error::Invalid(format!("{} needs {name}", op.id)))?;
            path = path.replace(&format!("{{{name}}}"), &encode(&as_param(&value)));
        }
        let mut query = Vec::new();
        for name in op.query {
            if let Some(value) = take(name).filter(|v| !v.is_null()) {
                query.push(format!("{}={}", encode(name), encode(&as_param(&value))));
            }
        }
        if !rest.is_empty() {
            let names: Vec<&str> = rest.iter().map(|(k, _)| *k).collect();
            return Err(Error::Invalid(format!(
                "{} takes no {}",
                op.id,
                names.join(", ")
            )));
        }
        match (&body, op.body) {
            (None, true) => return Err(Error::Invalid(format!("{} needs a body", op.id))),
            (Some(_), false) => return Err(Error::Invalid(format!("{} takes no body", op.id))),
            _ => {}
        }
        let url = format!(
            "{}{path}{}",
            self.base_url,
            if query.is_empty() {
                String::new()
            } else {
                format!("?{}", query.join("&"))
            }
        );
        let mut request = ureq::http::Request::builder()
            .method(op.method)
            .uri(&url)
            .header("Authorization", format!("Bearer {}", (self.token)()))
            .header("Accept", "application/json");
        if op.idempotency_key {
            let key = idempotency_key
                .map(str::to_string)
                .unwrap_or_else(fresh_key);
            request = request.header("Idempotency-Key", key);
        }
        let payload = match &body {
            Some(b) => {
                request = request.header("Content-Type", "application/json");
                b.to_string()
            }
            None => String::new(),
        };
        let request = request
            .body(payload)
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let mut response = self
            .agent
            .run(request)
            .map_err(|e| Error::Other(format!("Could not reach {}: {e}", self.base_url)))?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<f64>().ok())
            .map(|s| (s * 1000.0) as u64);
        let text = response.body_mut().read_to_string().unwrap_or_default();
        let parsed: Value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        if status >= 300 {
            return Err(api_error(status, &parsed, retry_after));
        }
        Ok(parsed)
    }
}

fn fresh_key() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "rs-{nanos:x}-{:x}-{:x}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}

/// The error a reply carries, whichever of the three error shapes it uses.
pub fn api_error(status: u16, body: &Value, retry_after_ms: Option<u64>) -> Error {
    match body.get("error") {
        // memory: {"error": {"code", "message", "retry_after_ms"?}}
        Some(Value::Object(e)) => Error::Api {
            status,
            code: e
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("error")
                .to_string(),
            message: e
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            retry_after_ms: e
                .get("retry_after_ms")
                .and_then(Value::as_u64)
                .or(retry_after_ms),
        },
        // routing, investigations, panels: {"error", "code"?}
        Some(Value::String(message)) => Error::Api {
            status,
            code: body
                .get("code")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or(format!("http_{status}")),
            message: message.clone(),
            retry_after_ms,
        },
        _ => Error::Api {
            status,
            code: format!("http_{status}"),
            message: match body {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            },
            retry_after_ms,
        },
    }
}
