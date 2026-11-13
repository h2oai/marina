// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! Typed command forms: the grammar each command declares, as the capabilities reply carries
//! it, and [`compose_command`], which fills a form into a command line with the TypeScript
//! SDK's validation rules.
//!
//! ```no_run
//! # fn demo(marina: &marina_sdk::Marina) -> marina_sdk::Result<()> {
//! use marina_sdk::compose_command;
//! use std::collections::HashMap;
//! let manifest = marina.capability_manifest()?;
//! let say = manifest.command("say").expect("say");
//! let form = say.forms.iter().find(|f| f.syntax.starts_with("say ")).expect("a say form");
//! let values = HashMap::from([("message".to_string(), "hello".to_string())]);
//! let composed = compose_command(form, &values, &HashMap::new());
//! assert!(composed.errors.is_empty());
//! marina.command(&composed.command)?;
//! # Ok(()) }
//! ```

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};

/// One value a form asks for.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CommandField {
    pub id: String,
    pub label: String,
    pub placeholder: String,
    /// The optional group this field belongs to, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optional_group: Option<String>,
    /// `text`, `number`, `json` or `choice`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
    /// Free text: spaces allowed.
    pub multiline: bool,
    pub allow_newlines: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integer: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wire_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

/// One piece of a form: a literal word, a field, or an optional group of parts.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FormPart {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FormPart>>,
}

/// An optional group: on when `enabled[id]` is true.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FormGroup {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

/// One usage form of a command.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CommandForm {
    /// `command` (default) or `named` (only its named tool takes it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    /// JSON Schema of the form's input.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
    /// `read`, `write`, `delete`, `execute` or `unknown`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub examples: Option<Vec<String>>,
    pub syntax: String,
    pub label: String,
    pub fields: Vec<CommandField>,
    pub groups: Vec<FormGroup>,
    pub parts: Vec<FormPart>,
}

/// One command in the capabilities reply.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CapabilityCommand {
    pub name: String,
    pub aliases: Vec<String>,
    pub category: String,
    pub help: String,
    pub min_rank: f64,
    pub forms: Vec<CommandForm>,
    /// Everything else the server sent about it.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The capabilities reply (`marina.capabilities.v1`), typed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Capabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub commands: Vec<CapabilityCommand>,
}

impl Capabilities {
    /// Read the reply `capabilities()` returns.
    pub fn from_reply(reply: &Map<String, Value>) -> crate::Result<Capabilities> {
        serde_json::from_value(Value::Object(reply.clone()))
            .map_err(|e| crate::Error::Other(format!("Unreadable capabilities reply: {e}")))
    }

    /// A command by name.
    pub fn command(&self, name: &str) -> Option<&CapabilityCommand> {
        self.commands.iter().find(|c| c.name == name)
    }
}

/// A composed command line and what was wrong with the values, by field id (or `form`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ComposedCommand {
    /// The command line; send it only when `errors` is empty.
    pub command: String,
    pub errors: BTreeMap<String, String>,
}

/// JavaScript's `Number(text)` for a trimmed, space-free value: `None` for NaN.
fn js_number(text: &str) -> Option<f64> {
    let lower = text.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = lower.strip_prefix(prefix) {
            return u128::from_str_radix(digits, radix).ok().map(|n| n as f64);
        }
    }
    match text.trim_start_matches(['+', '-']) {
        "Infinity" => {
            return Some(if text.starts_with('-') {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            });
        }
        // Rust spells these; JavaScript does not.
        t if t.eq_ignore_ascii_case("inf")
            || t.eq_ignore_ascii_case("infinity")
            || t.eq_ignore_ascii_case("nan") =>
        {
            return None;
        }
        _ => {}
    }
    text.parse::<f64>().ok()
}

/// A number as JavaScript prints it in a message.
fn js_display(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i128)
    } else {
        format!("{n}")
    }
}

/// `JSON.stringify(JSON.parse(text))` for valid JSON: insignificant whitespace removed, key
/// order kept.
fn compact_json(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    for c in text.chars() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if !c.is_whitespace() {
            out.push(c);
        }
    }
    out
}

/// Fill `form` with `values` (by field id, or by the field's label) and the optional groups
/// that are `enabled` (by group id). The same rules and messages as the TypeScript SDK's
/// `composeCommand`.
pub fn compose_command(
    form: &CommandForm,
    values: &HashMap<String, String>,
    enabled: &HashMap<String, bool>,
) -> ComposedCommand {
    let mut errors = BTreeMap::new();
    if form.encoding.as_deref() == Some("named") {
        errors.insert(
            "form".into(),
            "Use this form's named tool, or choose a command form".into(),
        );
        return ComposedCommand {
            command: String::new(),
            errors,
        };
    }
    let mut pieces: Vec<(String, bool)> = Vec::new();
    emit(form, &form.parts, values, enabled, &mut errors, &mut pieces);
    // Modifier prefixes and their fields form one token; ordinary arguments stay separated.
    let mut command = String::new();
    let mut join = true;
    for (text, joins) in pieces {
        let tight = join || text == "\n" || text == ":" || text == "=";
        if !tight {
            command.push(' ');
        }
        command.push_str(&text);
        join = joins || text == "\n";
    }
    ComposedCommand { command, errors }
}

fn emit(
    form: &CommandForm,
    parts: &[FormPart],
    values: &HashMap<String, String>,
    enabled: &HashMap<String, bool>,
    errors: &mut BTreeMap<String, String>,
    pieces: &mut Vec<(String, bool)>,
) {
    for part in parts {
        if let Some(group) = &part.group {
            if enabled.get(group).copied().unwrap_or(false) {
                let children = part.children.as_deref().unwrap_or(&[]);
                emit(form, children, values, enabled, errors, pieces);
            }
            continue;
        }
        if let Some(literal) = &part.literal {
            let joins = literal.ends_with(':') || literal.ends_with('=');
            pieces.push((literal.clone(), joins));
            continue;
        }
        let Some(f) = part
            .field
            .as_ref()
            .and_then(|id| form.fields.iter().find(|f| &f.id == id))
        else {
            continue;
        };
        let raw = values
            .get(&f.id)
            .or_else(|| values.get(&f.label))
            .or(f.default.as_ref())
            .cloned()
            .unwrap_or_default();
        let value = if f.allow_newlines {
            raw
        } else {
            raw.trim().to_string()
        };
        let error = check(form, f, &value);
        let text = match (&error, f.kind.as_str()) {
            (None, "json") if !value.is_empty() => compact_json(&value),
            _ => value,
        };
        if let Some(error) = error {
            errors.insert(f.id.clone(), error);
        }
        pieces.push((text, false));
    }
}

fn check(form: &CommandForm, f: &CommandField, value: &str) -> Option<String> {
    let kind = f.kind.as_str();
    let number = || js_number(value).unwrap_or(f64::NAN);
    if value.is_empty() {
        return Some("Required".into());
    }
    if value.contains(['\r', '\n']) && kind != "json" && !f.allow_newlines {
        return Some("Use a single line".into());
    }
    if form.syntax.contains(" | ") && value.contains('|') && kind != "json" {
        return Some("This field cannot contain a pipe separator".into());
    }
    if !f.multiline && kind != "choice" && value.chars().any(char::is_whitespace) {
        return Some("Use one value without spaces".into());
    }
    if kind == "number" {
        let n = number();
        if !n.is_finite() {
            return Some("Enter a number".into());
        }
        if f.integer == Some(true) && !(n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0) {
            return Some("Enter an integer".into());
        }
        if f.min.is_some_and(|min| n < min) || f.max.is_some_and(|max| n > max) {
            return Some(format!(
                "Enter a number between {} and {}",
                f.min.map_or("−∞".into(), js_display),
                f.max.map_or("∞".into(), js_display)
            ));
        }
    }
    if kind == "choice"
        && !f
            .choices
            .as_ref()
            .is_some_and(|c| c.iter().any(|c| c == value))
    {
        return Some("Choose one of the available values".into());
    }
    if kind == "json" {
        match serde_json::from_str::<Value>(value) {
            Err(_) => return Some("Enter valid JSON".into()),
            Ok(parsed) => {
                if f.placeholder.to_lowercase().contains("scalar")
                    && (parsed.is_object() || parsed.is_array())
                {
                    return Some("Enter a JSON string, number, boolean, or null".into());
                }
            }
        }
    }
    None
}
