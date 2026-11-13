// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//! Typed marina.http.v1 models and methods. Generated from
//! protocol/marina.http.v1.openapi.json by scripts/sdk-models/rust.ts (`bun run docs:api`);
//! do not edit by hand.
//!
//! Every object schema is a struct with the wire's field names (renamed to snake_case);
//! optional fields are `Option` and left out when `None`. Enum values are `String` (the
//! server may add values), and unions are `serde_json::Value`.

#![allow(clippy::too_many_arguments, clippy::large_enum_variant, clippy::should_implement_trait)]

use crate::error::{Error, Result};
use crate::http::HttpApi;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

fn to_body<T: Serialize>(body: &T) -> Result<Value> {
    serde_json::to_value(body).map_err(|e| Error::Invalid(format!("Could not encode the body: {e}")))
}

fn from_reply<T: DeserializeOwned>(reply: Value) -> Result<T> {
    serde_json::from_value(reply).map_err(|e| Error::Other(format!("Unreadable reply: {e}")))
}

/// A query number as the server reads it: whole numbers without a decimal point.
fn number(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 { Value::from(v as i64) } else { Value::from(v) }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct A2UIComponent {
    pub id: String,
    pub component: A2UIComponentType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<String>>,
    /// Every other field.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

pub type A2UIComponentType = String;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct A2UINodeDataLastAction {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<BTreeMap<String, Value>>,
    pub timestamp: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct A2UINodeData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub components: Vec<A2UIComponent>,
    #[serde(rename = "rootId", skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    #[serde(rename = "dataModel", skip_serializing_if = "Option::is_none")]
    pub data_model: Option<BTreeMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<BTreeMap<String, PanelSource>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(rename = "lastAction", skip_serializing_if = "Option::is_none")]
    pub last_action: Option<A2UINodeDataLastAction>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AbortTransferRequest {
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AcknowledgeMessageRequest {
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AcknowledgeRequest {
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AcknowledgeResponse {
    pub acknowledged: Vec<String>,
    pub missing: Vec<String>,
}

/// A routing or investigations failure.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ApiError {
    /// For people; wording may change.
    pub error: String,
    /// Stable, machine-readable: branch on this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistAdoptRequest {
    /// Defaults to the job's own space.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_space_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_time: Option<MemoryValidity>,
    /// Explicit `assistance_abstained_confirmed` credit for an abstained job; writes no record.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm_abstention: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistCancelRequest {
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistCancelResponse {
    pub id: String,
    pub state: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistClaimRequest {
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistClaimResponse {
    pub id: String,
    pub lease_token: String,
    pub lease_until: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistCreateResponse {
    pub id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistDelegateRequest {
    pub worker_id: String,
    pub role: MemoryHelperRole,
    pub task: String,
    pub lease_token: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistDelegateResponse {
    pub id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistFinishRequest {
    pub lease_token: String,
    pub completion: MemoryAnswer,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistFinishResponse {
    pub id: String,
    pub state: String,
    pub result_record_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistHeartbeatRequest {
    pub lease_token: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistHeartbeatResponse {
    pub id: String,
    pub lease_until: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistReadRequestRequest {
    pub operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistReadRequest {
    pub lease_token: String,
    pub request: AssistReadRequestRequest,
}

pub type AssistReadResponse = Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CacheDeleteResponse {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<f64>,
    pub removed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CancelAttemptRequest {
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CancelAttemptResponse {
    pub cancelled: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CanvasesResponseItem {
    pub id: String,
    pub name: String,
}

pub type CanvasesResponse = Vec<CanvasesResponseItem>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CanvasResponse {
    pub nodes: Vec<PublishedPanelNode>,
}

pub type CapabilitiesResponse = BTreeMap<String, Value>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CaptureBatchRequestItemsItem {
    pub content: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub key: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CaptureBatchRequest {
    pub items: Vec<CaptureBatchRequestItemsItem>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CaptureBatchResponse {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<f64>,
    pub receipts: Vec<MemoryReceipt>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CaptureRequest {
    pub content: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CatalogPanelSource {
    pub kind: String,
    pub resource: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ChannelsResponseChannelsItem {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ChannelsResponse {
    pub channels: Vec<ChannelsResponseChannelsItem>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CommitTransferRequest {
    pub sha256: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CommitTransferResponse {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<f64>,
    pub portable_ids_preserved: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ContextRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_stale: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expansion: Option<MemoryQueryExpansion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_degraded: Option<bool>,
    /// Validity of ranked records. Default: a record whose `valid_time.until` has passed (retired by a tombstone `revise`, a `resolve` loser) is excluded before ranking, so it never takes a result slot. `valid_at` (UTC ms) serves the records valid at that instant instead (`from <= t < until`, as `query` and `graph`). `include_ended: true` is the explicit history/audit read and returns every active record regardless of validity; it cannot be combined with `valid_at`. Exact `get`/`history` reads are never filtered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_ended: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_tokens: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ContextResponseCitationsItem {
    pub id: String,
    pub version: f64,
    pub source_ids: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ContextResponse {
    pub text: String,
    pub citations: Vec<ContextResponseCitationsItem>,
    pub estimated_tokens: f64,
    pub generation: f64,
    pub degraded: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ControlRequest {
    #[serde(rename = "targetId")]
    pub target_id: String,
    #[serde(rename = "clientMessageId")]
    pub client_message_id: String,
    pub control: RuntimeControl,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CreateCanvasRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CreateCanvasResponse {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CreateSpaceRequest {
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DeliveriesResponse {
    pub messages: Vec<RoutingMessage>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EraseInvestigationResponse {
    pub erased: bool,
}

pub type ExportResponse = BTreeMap<String, Value>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FederatedReadResponseOrigin {
    pub mount: String,
    pub space_id: String,
    pub id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FederatedReadResponse {
    pub origin: FederatedReadResponseOrigin,
    pub result: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FederatedRetrieveRequest {
    pub mounts: Vec<String>,
    pub retrieval: MemoryRetrievalInput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_partial: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FederationMountsResponse {
    pub mounts: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ForgetMemoryInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_generation: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct GrantInvestigationRequest {
    pub name: String,
    pub access: Option<InvestigationAccess>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct GrantInvestigationResponse {
    pub name: String,
    pub access: Option<InvestigationAccess>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct GrantRequest {
    pub principal_id: String,
    pub role: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct HeartbeatRequest {
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ImportBundleResponse {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<f64>,
    pub portable_ids_preserved: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InboxResponse {
    pub messages: Vec<RoutingMessage>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InteractPanelResponseReceipt {
    pub id: String,
    pub status: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InteractPanelResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<InteractPanelResponseReceipt>,
}

pub type InvestigationAccess = String;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationActor {
    /// Authenticated durable account, never a caller-supplied display name.
    pub key: String,
    pub name: String,
}

/// Mutable settlement, separate from the immutable answer (including after cancellation).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationAttemptAccounting {
    #[serde(rename = "knownUsd")]
    pub known_usd: f64,
    pub complete: bool,
    pub outstanding: f64,
    /// Coverage gaps are independent of outstanding calls and answer availability.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasons: Option<Vec<String>>,
    #[serde(rename = "pricedCalls", skip_serializing_if = "Option::is_none")]
    pub priced_calls: Option<f64>,
    #[serde(rename = "unknownCalls", skip_serializing_if = "Option::is_none")]
    pub unknown_calls: Option<f64>,
    /// Adapter totals can overlap; retained for diagnosis, never added to receipts.
    #[serde(rename = "reportedUsd", skip_serializing_if = "Option::is_none")]
    pub reported_usd: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationAttempt {
    pub id: String,
    #[serde(rename = "caseId")]
    pub case_id: String,
    pub actor: InvestigationActor,
    #[serde(rename = "parentAttemptId", skip_serializing_if = "Option::is_none")]
    pub parent_attempt_id: Option<String>,
    #[serde(rename = "rootAttemptId")]
    pub root_attempt_id: String,
    pub request: InvestigationRequest,
    pub state: InvestigationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    pub sequence: f64,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
    #[serde(rename = "updatedAt")]
    pub updated_at: f64,
    /// Mutable settlement, separate from the immutable answer (including after cancellation).
    pub accounting: InvestigationAttemptAccounting,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<InvestigationResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationCase {
    pub schema: String,
    pub id: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    pub owner: InvestigationActor,
    pub kind: InvestigationKind,
    pub question: String,
    #[serde(rename = "selectedAttemptId")]
    pub selected_attempt_id: String,
    #[serde(rename = "currentAttemptId", skip_serializing_if = "Option::is_none")]
    pub current_attempt_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
    #[serde(rename = "updatedAt")]
    pub updated_at: f64,
    pub access: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationContent {
    pub id: String,
    #[serde(rename = "attemptId")]
    pub attempt_id: String,
    pub label: String,
    pub value: Value,
    pub bytes: f64,
    pub hash: String,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationEvent {
    #[serde(rename = "attemptId")]
    pub attempt_id: String,
    pub sequence: f64,
    pub at: f64,
    pub kind: String,
    pub actor: String,
    #[serde(rename = "stageId", skip_serializing_if = "Option::is_none")]
    pub stage_id: Option<String>,
    #[serde(rename = "inputId", skip_serializing_if = "Option::is_none")]
    pub input_id: Option<String>,
    #[serde(rename = "outputId", skip_serializing_if = "Option::is_none")]
    pub output_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationEventPage {
    pub events: Vec<InvestigationEvent>,
    pub cursor: f64,
    pub more: bool,
    pub reset: bool,
}

pub type InvestigationKind = String;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationReason {
    pub actor: String,
    pub text: String,
    /// Only declared citations; proximity to a source is not entailment.
    #[serde(rename = "sourceIds")]
    pub source_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationRequestLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calls: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<f64>,
    #[serde(rename = "timeoutMs", skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationRequest {
    pub kind: InvestigationKind,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<PredictionShape>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub horizon: Option<String>,
    #[serde(rename = "asOf", skip_serializing_if = "Option::is_none")]
    pub as_of: Option<String>,
    /// Existing case for a new attempt; prior results remain immutable.
    #[serde(rename = "caseId", skip_serializing_if = "Option::is_none")]
    pub case_id: Option<String>,
    /// An owned child while its parent runs; otherwise a new episode referencing prior work.
    #[serde(rename = "parentAttemptId", skip_serializing_if = "Option::is_none")]
    pub parent_attempt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<InvestigationRequestLimits>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationResultCapture {
    pub status: String,
    pub gaps: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationResultAccounting {
    #[serde(rename = "knownUsd")]
    pub known_usd: f64,
    pub complete: bool,
    pub outstanding: f64,
    /// Coverage gaps are independent of outstanding calls and answer availability.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasons: Option<Vec<String>>,
    #[serde(rename = "pricedCalls", skip_serializing_if = "Option::is_none")]
    pub priced_calls: Option<f64>,
    #[serde(rename = "unknownCalls", skip_serializing_if = "Option::is_none")]
    pub unknown_calls: Option<f64>,
    /// Adapter totals can overlap; retained for diagnosis, never added to receipts.
    #[serde(rename = "reportedUsd", skip_serializing_if = "Option::is_none")]
    pub reported_usd: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationResult {
    pub schema: String,
    pub kind: InvestigationKind,
    pub summary: String,
    pub availability: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate: Option<PredictionEstimate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<String>,
    pub reasons: Vec<InvestigationReason>,
    pub sources: Vec<InvestigationSource>,
    pub limitations: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub horizon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cutoff: Option<String>,
    #[serde(rename = "answerId", skip_serializing_if = "Option::is_none")]
    pub answer_id: Option<f64>,
    /// Raw executor output is private content, loaded separately from a compact result.
    #[serde(rename = "outputId", skip_serializing_if = "Option::is_none")]
    pub output_id: Option<String>,
    pub capture: InvestigationResultCapture,
    pub accounting: InvestigationResultAccounting,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationSnapshotAttemptsItem {
    pub id: String,
    pub actor: InvestigationActor,
    pub state: InvestigationState,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationSnapshotChildrenItem {
    #[serde(rename = "caseId")]
    pub case_id: String,
    #[serde(rename = "attemptId")]
    pub attempt_id: String,
    pub question: String,
    pub state: InvestigationState,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationSnapshotResolution {
    pub at: f64,
    pub value: Value,
    pub loss: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationSnapshotGrantsItem {
    pub name: String,
    pub access: InvestigationAccess,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationSnapshot {
    pub case: InvestigationCase,
    pub attempt: InvestigationAttempt,
    pub attempts: Vec<InvestigationSnapshotAttemptsItem>,
    /// Cursor and state are read in one transaction.
    pub cursor: f64,
    pub children: Vec<InvestigationSnapshotChildrenItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<InvestigationSnapshotResolution>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grants: Option<Vec<InvestigationSnapshotGrantsItem>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InvestigationSource {
    pub id: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

pub type InvestigationState = String;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct IssueSupervisionRequest {
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct JsonStoreRequest {
    pub operations: Vec<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct JsonStoreResponse {
    pub results: Vec<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct KnowledgeGraphRequest {
    pub action: MemoryGraphAction,
}

pub type KnowledgeGraphResponse = BTreeMap<String, Value>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LeaveRequest {
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ListInvestigationsResponse {
    pub cases: Vec<InvestigationCase>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MaterializeRuleRequest {
    pub id: String,
    pub expected_version: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_at: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MaterializeRuleResponse {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<f64>,
    pub records: Vec<MemoryReceipt>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryAdoptInput {
    pub job_id: String,
    /// Defaults to the job's own space.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_space_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_time: Option<MemoryValidity>,
    /// Explicit `assistance_abstained_confirmed` credit for an abstained job; writes no record.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm_abstention: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryAdoptResult {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<f64>,
    pub job_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<f64>,
    pub space_id: String,
    pub state: String,
    /// True when this call returned an adoption that already existed.
    pub existing: bool,
    pub ratified_by: Option<MemoryRatifiedBy>,
    pub credited: Vec<MemoryStandingCredit>,
}

pub type MemoryAnswer = Value;

/// Assistance is explicitly delegated reading and a cited proposal, never a grant to edit the requester's memories or to certify a claim as true.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryAssistanceInput {
    pub worker_id: String,
    pub role: MemoryHelperRole,
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_operations: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryAssistanceJob {
    pub id: String,
    pub space_id: String,
    pub requester_id: String,
    pub worker_id: String,
    pub role: MemoryHelperRole,
    pub parent_id: Option<String>,
    pub root_id: String,
    pub depth: f64,
    pub state: String,
    /// Live deadline/ancestor projection; state retains the last recorded transition.
    pub work_open: bool,
    pub version: f64,
    pub lease_until: Option<f64>,
    pub deadline: f64,
    pub remaining_operations: f64,
    pub input_source_id: String,
    pub result_record_id: Option<String>,
    pub created_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<MemoryAnswer>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryAssistancePage {
    pub jobs: Vec<MemoryAssistanceJob>,
    pub next_cursor: Option<String>,
}

pub type MemoryBinding = Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryBundlePayloadSourcesItem {
    pub id: String,
    pub space_id: String,
    pub seq: f64,
    pub session_id: Option<String>,
    pub body: Value,
    pub content_hash: String,
    pub created_at: f64,
    pub body_sha256: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryBundlePayloadRecordsItemVersionsItem {
    pub record: MemoryRecord,
    pub attributes: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryBundlePayloadRecordsItem {
    pub id: String,
    pub version: f64,
    pub created_at: f64,
    pub stale: f64,
    pub stale_reason: Option<String>,
    pub versions: Vec<MemoryBundlePayloadRecordsItemVersionsItem>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryBundlePayloadVocabulariesItem {
    pub version: f64,
    pub definition: String,
    pub created_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryBundlePayloadCheckpointsItem {
    pub name: String,
    pub version: f64,
    pub source_cursor: f64,
    pub data: String,
    pub updated_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryBundlePayload {
    pub origin_space: String,
    pub sources: Vec<MemoryBundlePayloadSourcesItem>,
    pub records: Vec<MemoryBundlePayloadRecordsItem>,
    pub vocabularies: Vec<MemoryBundlePayloadVocabulariesItem>,
    pub checkpoints: Vec<MemoryBundlePayloadCheckpointsItem>,
}

/// Portable history envelope. Authorization and indexes are deliberately excluded.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryBundle {
    pub schema: String,
    pub sha256: String,
    pub payload: MemoryBundlePayload,
    pub excluded: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCachedRetrievalInputRetrieval {
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<MemorySelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expansion: Option<MemoryQueryExpansion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requirements: Option<Vec<Value>>,
    /// Include a bounded candidate pool for explicit episode capture and offline comparison.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observe: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<MemoryPlanStep>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_model: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broaden: Option<bool>,
    pub valid_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_results: Option<f64>,
    /// Serialized evidence-array budget; plan and diagnostic metadata are separate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<f64>,
    /// Maximum UTF-8 text bytes read per original source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_bytes: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCachedRetrievalInput {
    pub retrieval: MemoryCachedRetrievalInputRetrieval,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mounts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_partial: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCachedRetrievalResultCache {
    pub hit: bool,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stored: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCachedRetrievalResult {
    pub retrieval: Value,
    pub cache: MemoryCachedRetrievalResultCache,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCacheInput {
    pub inputs: Value,
    pub model: String,
    pub policy: String,
}

pub type MemoryCacheResult = Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCacheWriteRecordsItem {
    pub id: String,
    pub version: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCacheWriteSourcesItem {
    pub id: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCacheWrite {
    pub inputs: Value,
    pub model: String,
    pub policy: String,
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub records: Option<Vec<MemoryCacheWriteRecordsItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<MemoryCacheWriteSourcesItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub federated: Option<Vec<MemoryFederatedPin>>,
    pub expires_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCheckpoint {
    pub name: String,
    pub version: f64,
    pub source_cursor: f64,
    pub data: BTreeMap<String, Value>,
    pub updated_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCheckpointCaptureItemsItem {
    pub content: Value,
    pub key: String,
}

/// The server adds `source_ids` (resolved `order`) to this content.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCheckpointCaptureManifest {
    pub key: String,
    pub content: BTreeMap<String, Value>,
}

/// Input of an atomic checkpoint capture (`capture_checkpoint`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCheckpointCapture {
    pub expected_version: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// New sources; `order` refers to them by index. At most 64, 1 MiB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<MemoryCheckpointCaptureItemsItem>>,
    /// The manifest's sources in order: an existing source id or a new item's index.
    pub order: Vec<Value>,
    /// The server adds `source_ids` (resolved `order`) to this content.
    pub manifest: MemoryCheckpointCaptureManifest,
    /// Checkpoint data field set to `entry` plus `source_ids` and `manifest_source_id`.
    pub field: String,
    pub entry: BTreeMap<String, Value>,
    /// The rest of the checkpoint data.
    pub data: BTreeMap<String, Value>,
    /// Other sources the checkpoint keeps referring to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ids: Option<Vec<String>>,
    /// `"manifest"` = the manifest's sequence number, else an explicit cursor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Value>,
    pub checkpoint_key: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCheckpointCaptureReceiptManifest {
    pub id: String,
    pub seq: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryCheckpointCaptureReceipt {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<f64>,
    pub manifest: MemoryCheckpointCaptureReceiptManifest,
    pub source_ids: Vec<String>,
}

pub type MemoryCitation = Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryClaim {
    pub subject: String,
    pub predicate: String,
    pub object: MemoryTerm,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryErrorError {
    /// Stable, machine-readable: branch on this.
    pub code: String,
    /// For people; wording may change.
    pub message: String,
    /// When present, wait this long before retrying (exact; `Retry-After` is whole seconds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<f64>,
}

/// Every memory API failure.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryError {
    pub error: MemoryErrorError,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryExpansionCoverage {
    pub policy: String,
    pub queries: Vec<String>,
    pub candidates: Vec<f64>,
    pub candidate_limit: f64,
    pub fusion: String,
}

pub type MemoryFederatedEntry = Value;

/// Explicit remote provenance; mounts are configured by the operator, never URLs.
pub type MemoryFederatedPin = Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryFederatedRead {
    pub mount: String,
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryFederatedResultFailuresItem {
    pub mount: String,
    pub code: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryFederatedResult {
    pub results: Vec<MemoryFederatedEntry>,
    pub failures: Vec<MemoryFederatedResultFailuresItem>,
    pub incomplete: bool,
    pub bytes: f64,
    pub truncated: bool,
    pub consistency: String,
    pub replicated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryFederatedRetrievalResultPeersItem {
    pub mount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrieval_generation: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vocabulary_version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryFederatedRetrievalResult {
    pub schema: String,
    pub evidence: Vec<Value>,
    pub peers: Vec<MemoryFederatedRetrievalResultPeersItem>,
    pub bytes: f64,
    pub consistency: String,
    pub answer_sufficiency: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryFederatedSearch {
    pub mounts: Vec<String>,
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_partial: Option<bool>,
}

pub type MemoryGraphAction = String;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryGraphQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_stale: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_at: Option<f64>,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub predicates: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryGraphResultEdgesItem {
    pub record: MemoryRecord,
    pub path: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryGraphResult {
    pub space_id: String,
    pub generation: f64,
    pub root: String,
    pub edges: Vec<MemoryGraphResultEdgesItem>,
    pub truncated: bool,
}

pub type MemoryHelperRole = String;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryJobStatus {
    pub id: String,
    pub space_id: String,
    pub record_id: String,
    pub note_id: f64,
    pub model: String,
    pub state: String,
    pub attempts: f64,
    pub lease_until: Option<f64>,
    pub error: Option<String>,
    pub created_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryJoin {
    pub patterns: Vec<MemoryPattern>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub select: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryJoinResultTraceItem {
    pub pattern: f64,
    pub candidates: f64,
    pub matches: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryJoinResult {
    pub space_id: String,
    pub generation: f64,
    pub results: Vec<MemoryMatch>,
    pub truncated: bool,
    pub trace: Vec<MemoryJoinResultTraceItem>,
    pub semantics: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryMatchWitnessesItem {
    pub id: String,
    pub version: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryMatch {
    pub bindings: BTreeMap<String, MemoryBinding>,
    pub witnesses: Vec<MemoryMatchWitnessesItem>,
    pub valid_time: MemoryValidity,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryPattern {
    pub subject: Value,
    pub predicate: Value,
    pub object: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryPlanBudget {
    pub max_results: f64,
    pub max_bytes: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryPlan {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrieval_generation: Option<f64>,
    pub schema: String,
    pub space_id: String,
    pub generation: f64,
    pub vocabulary_version: f64,
    pub task: String,
    pub planner: String,
    pub assumptions: Vec<String>,
    pub steps: Vec<MemoryPlanStep>,
    pub budget: MemoryPlanBudget,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryPlanResultTraceItem {
    pub operation: String,
    pub input: BTreeMap<String, Value>,
    pub evidence: Vec<Value>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryPlanResult {
    pub space_id: String,
    pub generation: f64,
    pub trace: Vec<MemoryPlanResultTraceItem>,
    pub bytes: f64,
    pub truncated: bool,
    pub answer_sufficiency: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryPlanStep {
    pub operation: String,
    pub input: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_stale: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub predicate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<MemoryTerm>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// Caller-selected alternatives are retrieval hints, never new assertions.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryQueryExpansion {
    pub policy: String,
    pub queries: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryQueryResult {
    pub space_id: String,
    pub generation: f64,
    pub mode: String,
    pub results: Vec<MemoryRecord>,
    pub next_cursor: Option<String>,
}

/// Why a record lives in a shared (institutional) space. Stamped by `adopt` and `pool <name> ratify`; every institutional record answers "why is this shared?" from its own metadata.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRatifiedBy {
    pub principal_id: String,
    pub name: String,
    pub standing: f64,
    pub at: f64,
    pub rationale: Option<String>,
    /// Which rule admitted the ratifier.
    pub basis: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryReceipt {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRecordStaleReason {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_version: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub freshness: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_reason: Option<MemoryRecordStaleReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependency_versions: Option<BTreeMap<String, Option<f64>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_time: Option<MemoryValidity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vocabulary_version: Option<f64>,
    pub id: String,
    pub space_id: String,
    pub version: f64,
    pub content: String,
    pub r#type: String,
    pub tier: String,
    pub importance: f64,
    pub subject: Option<String>,
    pub metadata: BTreeMap<String, Value>,
    pub source_ids: Vec<String>,
    pub depends_on: Vec<String>,
    pub created_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim: Option<MemoryClaim>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRecordInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependency_versions: Option<BTreeMap<String, f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_time: Option<MemoryValidity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_vocabulary_version: Option<f64>,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub importance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim: Option<MemoryClaim>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryReputationRankingAuthorsValue {
    pub author: Option<String>,
    pub standing: f64,
    pub term: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryReputationRankingUsefulnessItemsValue {
    pub alpha: f64,
    pub beta: f64,
    pub n: f64,
    pub mean: f64,
    pub term: f64,
}

/// Usefulness factor from others' evidence (`MARINA_MEMORY_USEFULNESS_RANKING`); absent when off.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryReputationRankingUsefulness {
    pub mode: String,
    pub weight: f64,
    pub applied: bool,
    pub items: BTreeMap<String, MemoryReputationRankingUsefulnessItemsValue>,
}

/// Reputation-weighted re-rank applied to SHARED-space search results (records the actor does not own). Bounded, inspectable, deterministic — see db-memory-ranking.ts.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryReputationRanking {
    pub weight: f64,
    pub standing_ceiling: f64,
    pub applied: f64,
    pub considered: f64,
    pub authors: BTreeMap<String, MemoryReputationRankingAuthorsValue>,
    /// Usefulness factor from others' evidence (`MARINA_MEMORY_USEFULNESS_RANKING`); absent when off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usefulness: Option<MemoryReputationRankingUsefulness>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryResolutionMembership {
    pub id: String,
    pub policy: MemoryResolvePolicy,
    pub status: MemoryResolutionStatus,
    pub role: MemoryResolutionRole,
    pub rationale: String,
    pub deadline: Option<f64>,
    pub created_at: f64,
}

pub type MemoryResolutionRole = String;

pub type MemoryResolutionStatus = String;

/// Typed write-time operators over the review queue. Every policy writes an append-only audit row; none deletes history.
pub type MemoryResolvePolicy = String;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryResolveResultSupersededItem {
    pub id: String,
    pub version: f64,
    pub valid_time: Option<MemoryValidity>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryResolveResult {
    /// Resolution (audit row) ID.
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<f64>,
    pub record_id: String,
    pub policy: MemoryResolvePolicy,
    pub status: MemoryResolutionStatus,
    pub winner: Option<String>,
    pub superseded: Vec<MemoryResolveResultSupersededItem>,
    pub peers: Vec<String>,
    pub pending: Vec<String>,
    pub evidence_counts: Option<BTreeMap<String, f64>>,
    pub deadline: Option<f64>,
}

/// One bounded retrieval, including witnessed original-source reads.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRetrievalInput {
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<MemorySelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expansion: Option<MemoryQueryExpansion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requirements: Option<Vec<Value>>,
    /// Include a bounded candidate pool for explicit episode capture and offline comparison.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observe: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<MemoryPlanStep>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_model: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broaden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_results: Option<f64>,
    /// Serialized evidence-array budget; plan and diagnostic metadata are separate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<f64>,
    /// Maximum UTF-8 text bytes read per original source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_bytes: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRetrievalResultTraceItem {
    pub operation: String,
    pub input: BTreeMap<String, Value>,
    pub returned: f64,
    pub truncated: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRetrievalResultBudget {
    pub max_results: f64,
    pub max_bytes: f64,
    pub source_bytes: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRetrievalResultSelectedRecipe {
    pub space_id: String,
    pub id: String,
    pub version: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRetrievalResultCoverageItem {
    pub requirement: Value,
    pub covered: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRetrievalResultKnownConflictsItem {
    pub subject: String,
    pub predicate: String,
    pub records: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRetrievalResultDiagnostics {
    pub broadened: bool,
    pub discovery_truncated: bool,
    pub budget_limited: bool,
    pub filtered_records: f64,
    pub partial_sources: f64,
    pub next_actions: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRetrievalResult {
    pub schema: String,
    pub space_id: String,
    pub generation: f64,
    pub retrieval_generation: f64,
    pub vocabulary_version: f64,
    pub valid_at: f64,
    pub status: String,
    pub plan: MemoryPlan,
    pub evidence: Vec<MemoryRetrievedEvidence>,
    pub trace: Vec<MemoryRetrievalResultTraceItem>,
    pub budget: MemoryRetrievalResultBudget,
    pub bytes: f64,
    pub truncated: bool,
    pub answer_sufficiency: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<MemorySelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_contract: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_recipe: Option<MemoryRetrievalResultSelectedRecipe>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_candidates: Option<Vec<MemoryRetrievedEvidence>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage: Option<Vec<MemoryRetrievalResultCoverageItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_conflicts: Option<Vec<MemoryRetrievalResultKnownConflictsItem>>,
    pub diagnostics: MemoryRetrievalResultDiagnostics,
    pub limitations: Vec<String>,
}

pub type MemoryRetrievedEvidence = Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryReviewResultItemsItemPremisesItem {
    pub id: String,
    pub pinned_version: Option<f64>,
    pub current_version: Option<f64>,
    pub state: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryReviewResultItemsItem {
    pub record: MemoryRecord,
    pub premises: Vec<MemoryReviewResultItemsItemPremisesItem>,
    pub competing_records: Vec<MemoryRecord>,
    pub competing_truncated: bool,
    /// The record's live resolution membership, when one exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<MemoryResolutionMembership>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryReviewResult {
    pub space_id: String,
    pub retrieval_generation: f64,
    pub items: Vec<MemoryReviewResultItemsItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRule {
    pub schema: String,
    pub name: String,
    pub query: MemoryJoin,
    pub conclusion: MemoryPattern,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRuleResultResultsItemWitnessesItem {
    pub id: String,
    pub version: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRuleResultResultsItem {
    pub bindings: BTreeMap<String, MemoryBinding>,
    pub witnesses: Vec<MemoryRuleResultResultsItemWitnessesItem>,
    pub valid_time: MemoryValidity,
    pub claim: MemoryClaim,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRuleResultTraceItem {
    pub pattern: f64,
    pub candidates: f64,
    pub matches: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRuleResultRule {
    pub id: String,
    pub version: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryRuleResult {
    pub space_id: String,
    pub generation: f64,
    pub results: Vec<MemoryRuleResultResultsItem>,
    pub truncated: bool,
    pub trace: Vec<MemoryRuleResultTraceItem>,
    pub semantics: String,
    pub rule: MemoryRuleResultRule,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySearchInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_stale: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expansion: Option<MemoryQueryExpansion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_degraded: Option<bool>,
    /// Validity of ranked records. Default: a record whose `valid_time.until` has passed (retired by a tombstone `revise`, a `resolve` loser) is excluded before ranking, so it never takes a result slot. `valid_at` (UTC ms) serves the records valid at that instant instead (`from <= t < until`, as `query` and `graph`). `include_ended: true` is the explicit history/audit read and returns every active record regardless of validity; it cannot be combined with `valid_at`. Exact `get`/`history` reads are never filtered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_ended: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySearchResultCoverageSemantic {
    pub scored: f64,
    pub missing: f64,
    pub invalid: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySearchResultCoverage {
    pub candidate_limit: f64,
    pub lexical_candidates: f64,
    pub semantic: Option<MemorySearchResultCoverageSemantic>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySearchResultResultsItemStaleReason {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_version: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySearchResultResultsItemRanks {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lexical: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expansion: Option<Vec<Option<f64>>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySearchResultResultsItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub freshness: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_reason: Option<MemorySearchResultResultsItemStaleReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependency_versions: Option<BTreeMap<String, Option<f64>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_time: Option<MemoryValidity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vocabulary_version: Option<f64>,
    pub id: String,
    pub space_id: String,
    pub version: f64,
    pub content: String,
    pub r#type: String,
    pub tier: String,
    pub importance: f64,
    pub subject: Option<String>,
    pub metadata: BTreeMap<String, Value>,
    pub source_ids: Vec<String>,
    pub depends_on: Vec<String>,
    pub created_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim: Option<MemoryClaim>,
    pub score: f64,
    pub ranks: MemorySearchResultResultsItemRanks,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySearchResult {
    /// Present only when the actor is not the space owner and ≥1 record was considered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ranking: Option<MemoryReputationRanking>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expansion: Option<MemoryExpansionCoverage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage: Option<MemorySearchResultCoverage>,
    pub space_id: String,
    pub generation: f64,
    pub mode: String,
    pub model: Option<String>,
    pub degraded: Vec<String>,
    pub results: Vec<MemorySearchResultResultsItem>,
}

pub type MemorySelection = String;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySource {
    pub id: String,
    pub space_id: String,
    pub seq: f64,
    pub session_id: Option<String>,
    pub body: Value,
    pub content_hash: String,
    pub created_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySourceRange {
    pub id: String,
    pub session_id: Option<String>,
    pub content_hash: String,
    pub text_hash: String,
    pub representation: String,
    pub start: f64,
    pub end: f64,
    pub total_bytes: f64,
    pub next_start: Option<f64>,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySourceSearch {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expansion: Option<MemoryQueryExpansion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#match: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySourceSearchResultResultsItemRanks {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lexical: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expansion: Option<Vec<Option<f64>>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySourceSearchResultResultsItem {
    pub id: String,
    pub seq: f64,
    pub session_id: Option<String>,
    pub content_hash: String,
    pub excerpt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ranks: Option<MemorySourceSearchResultResultsItemRanks>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySourceSearchResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expansion: Option<MemoryExpansionCoverage>,
    pub space_id: String,
    pub generation: f64,
    pub results: Vec<MemorySourceSearchResultResultsItem>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySpace {
    pub retrieval_generation: f64,
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub generation: f64,
    pub status: String,
    pub created_at: f64,
    /// Operator-set flags (migration 114). `institutional: true` makes `adopt` a standing-gated ratification; `read_public: true` grants every active credential read access. Never settable over HTTP.
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryStandingCredit {
    pub principal_id: String,
    pub kind: String,
    pub r#ref: String,
    pub amount: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryStorageAmounts {
    pub logical_bytes: f64,
    pub sources: f64,
    pub revisions: f64,
    pub spaces: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryStorageUsage {
    pub owner_id: String,
    pub usage: MemoryStorageAmounts,
    pub limits: MemoryStorageAmounts,
    pub over_limit: Vec<String>,
}

pub type MemoryTerm = Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryTransferFragment {
    pub kind: MemoryTransferKind,
    pub id: String,
    pub version: f64,
    pub offset: f64,
    pub size: f64,
    pub sha256: String,
    pub base64: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryTransferHeaderCounts {
    pub source: f64,
    pub record: f64,
    pub revision: f64,
    pub vocabulary: f64,
    pub checkpoint: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryTransferHeader {
    pub schema: String,
    pub origin_space: String,
    pub generation: f64,
    pub counts: MemoryTransferHeaderCounts,
}

pub type MemoryTransferKind = String;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryTransferListTransfersItem {
    pub id: String,
    pub header: MemoryTransferHeader,
    pub state: String,
    pub position: f64,
    pub sha256: String,
    pub bytes: f64,
    pub next_cursor: Option<String>,
    pub expires_at: f64,
    pub expired: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryTransferList {
    pub transfers: Vec<MemoryTransferListTransfersItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryTransferPage {
    pub header: MemoryTransferHeader,
    pub position: f64,
    pub previous: String,
    pub fragments: Vec<MemoryTransferFragment>,
    pub done: bool,
    pub sha256: String,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryTransferStatus {
    pub id: String,
    pub header: MemoryTransferHeader,
    pub state: String,
    pub position: f64,
    pub sha256: String,
    pub bytes: f64,
    pub next_cursor: Option<String>,
    pub expires_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryValidity {
    pub from: Option<f64>,
    pub until: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryVariable {
    pub variable: String,
    pub r#type: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryVocabulary {
    pub version: f64,
    pub definition: MemoryVocabularyDefinition,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryVocabularyDefinitionPredicatesValue {
    pub object: String,
    pub cardinality: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryVocabularyDefinition {
    pub closed: bool,
    pub predicates: BTreeMap<String, MemoryVocabularyDefinitionPredicatesValue>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MeResponse {
    pub principal_id: String,
    pub credential_id: String,
    pub scopes: Vec<String>,
}

/// A canvas or panel failure. `code` is present on some failures only.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PanelError {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PanelInteractionInput {
    pub revision: String,
    #[serde(rename = "componentId")]
    pub component_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<BTreeMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(rename = "sourceId", skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(rename = "capabilityRevision", skip_serializing_if = "Option::is_none")]
    pub capability_revision: Option<f64>,
}

/// Read adapters, not grants. Every fetch still passes through the resource's own authorization. Keep side-effecting GETs (notably entities/:name/canvas), credentials and arbitrary URLs out. Parameters are encoded as individual path segments; query keys are declared per adapter.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PanelResourceDefinition {
    pub id: String,
    pub path: String,
    pub parameters: Vec<String>,
    pub query: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PanelResourcesResponse {
    pub schema: String,
    pub resources: Vec<PanelResourceDefinition>,
}

pub type PanelSource = Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PlanRequest {
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_model: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<MemoryPlanStep>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_results: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<f64>,
}

pub type PredictionEstimate = Value;

pub type PredictionShape = Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishedPanelNodeData {
    #[serde(rename = "panelRevision", skip_serializing_if = "Option::is_none")]
    pub panel_revision: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishedPanelNode {
    pub id: String,
    pub canvas_id: String,
    pub r#type: String,
    pub creator_name: String,
    pub updated_at: f64,
    pub data: PublishedPanelNodeData,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishPanelRequest {
    pub r#type: String,
    pub data: A2UINodeData,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishRequest {
    pub events: Vec<RoutingEventInput>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PublishResponse {
    pub events: Vec<RoutingEvent>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReaffirmRequest {
    pub id: String,
    pub expected_version: f64,
    pub dependency_versions: BTreeMap<String, f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReindexRequest {
    pub expected_generation: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReindexResponse {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<f64>,
    pub generation: f64,
    pub model: String,
    pub job_ids: Vec<String>,
    pub examined: f64,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RenewResidentRequest {
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RenewResidentResponse {
    pub name: String,
    pub credential: ResidentCredential,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RenewSupervisionRequest {
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReportResidentAttentionResponse {
    pub name: String,
    pub recorded: f64,
}

/// How a supervised resident's attention bridge decides and relays.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResidentAttentionPolicy {
    pub mode: String,
    pub threshold: f64,
    pub relay: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResidentAttentionReportWakesItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    pub source: String,
    pub decision: String,
    pub reason: String,
    pub hop: f64,
    pub steered: bool,
    pub at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResidentAttentionReportOutcomesItem {
    pub r#ref: String,
    pub worked: bool,
}

/// The resident's current presence, when it changed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResidentAttentionReportStatus {
    pub status: String,
    pub steer: String,
}

/// `POST /api/routing/residents/:name/attention`: bridge decisions and presence.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResidentAttentionReport {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// Wake decisions (refs and reasons only, never content), at most 100.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wakes: Option<Vec<ResidentAttentionReportWakesItem>>,
    /// What woken turns did, at most 100: whether the agent ran a tool or a world command of its own after the wake (the attention judges' truth). Refs only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcomes: Option<Vec<ResidentAttentionReportOutcomesItem>>,
    /// The resident's current presence, when it changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<ResidentAttentionReportStatus>,
}

/// A resident's world credential, returned once and never stored by the server.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResidentCredential {
    pub token: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: f64,
}

/// `POST /api/routing/residents` input: enrol the agent of one owned run session.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResidentEnrolInput {
    /// The run's routing session; its `kind` (the adapter id) is the vendor.
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// Requested world name. Omitted: the agent's proposal, else a fresh word-list name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The agent's own proposal (used only without `name`). The server sanitizes and dedupes it and never takes a vendor or model word; an unusable proposal falls back to the word list instead of failing.
    #[serde(rename = "proposedName", skip_serializing_if = "Option::is_none")]
    pub proposed_name: Option<String>,
    /// Room to arrive in. Omitted: the launching person's current room.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResidentEnrolment {
    pub name: String,
    pub vendor: String,
    /// The person who owns the resident (the enrolling account's world name).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// Room the resident should arrive in, when one is known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    /// True when an existing resident account of the same owner was reused.
    pub reused: bool,
    /// Where the name came from: the launch request, the agent's proposal, or the word list.
    #[serde(rename = "nameSource", skip_serializing_if = "Option::is_none")]
    pub name_source: Option<ResidentNameSource>,
    pub credential: ResidentCredential,
    /// The resident's stored attention policy (supervised residents' attention bridge).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention: Option<ResidentAttentionPolicy>,
}

/// Where a resident's name came from.
pub type ResidentNameSource = String;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResolveAttemptRequest {
    pub value: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResolveAttemptResponse {
    #[serde(rename = "answerId")]
    pub answer_id: f64,
    pub loss: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResolveRequest {
    pub policy: MemoryResolvePolicy,
    /// Competing record IDs (1–32); the head record is the operation target.
    pub competing: Vec<String>,
    pub rationale: String,
    /// Explicit cutoff for closing losers; `from` overrides the winner's `valid_from`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_time: Option<MemoryValidity>,
    /// await_confirmation only: relative deadline in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<f64>,
    pub id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReviewAttemptRequest {
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReviewRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RevisePanelRequest {
    pub revision: String,
    pub data: A2UINodeData,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReviseRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependency_versions: Option<BTreeMap<String, f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_time: Option<MemoryValidity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_vocabulary_version: Option<f64>,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub importance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim: Option<MemoryClaim>,
    pub expected_version: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RevokeResidentRequest {
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RevokeResidentResponse {
    pub name: String,
    pub revoked: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RevokeSupervisionRequest {
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RevokeSupervisionResponse {
    pub revoked: bool,
}

/// References to Marina's existing channel_messages; this is not a second conversation log.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingChannelMessage {
    pub id: f64,
    #[serde(rename = "channelId")]
    pub channel_id: String,
    #[serde(rename = "senderId")]
    pub sender_id: String,
    #[serde(rename = "senderName")]
    pub sender_name: String,
    pub content: String,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingChannelPage {
    pub messages: Vec<RoutingChannelMessage>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: f64,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingChannelReceipt {
    pub message: RoutingChannelMessage,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingEvent {
    /// Stable producer id; reuse unchanged when retrying a batch.
    pub id: String,
    pub kind: String,
    pub payload: Value,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub sequence: f64,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingEventInput {
    /// Stable producer id; reuse unchanged when retrying a batch.
    pub id: String,
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingEventPage {
    pub events: Vec<RoutingEvent>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: f64,
    #[serde(rename = "lastSequence")]
    pub last_sequence: f64,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
    /// Requested history was pruned. Consumers must show this instead of implying completeness.
    pub gap: bool,
}

/// Version 1: transport-neutral participants. Capabilities describe clients, not permissions.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingJoin {
    #[serde(rename = "clientKey")]
    pub client_key: String,
    pub label: String,
    pub kind: String,
    #[serde(rename = "groupId", skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingMessage {
    #[serde(rename = "clientMessageId")]
    pub client_message_id: String,
    #[serde(rename = "targetId")]
    pub target_id: String,
    pub kind: String,
    pub payload: Value,
    pub id: String,
    #[serde(rename = "sourceId")]
    pub source_id: String,
    pub status: String,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
    #[serde(rename = "acknowledgedAt")]
    pub acknowledged_at: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingOverview {
    pub items: Vec<RoutingOverviewItem>,
    pub total: f64,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
}

/// Account-scoped observer projection; runtime data is reported by the participant.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingOverviewItem {
    pub session: RoutingSession,
    pub runtime: Option<Value>,
    #[serde(rename = "lastDelivery")]
    pub last_delivery: Option<RoutingEvent>,
    pub owned: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingSend {
    #[serde(rename = "clientMessageId")]
    pub client_message_id: String,
    #[serde(rename = "targetId")]
    pub target_id: String,
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingSession {
    pub id: String,
    #[serde(rename = "ownerId")]
    pub owner_id: String,
    #[serde(rename = "clientKey")]
    pub client_key: String,
    pub label: String,
    pub kind: String,
    #[serde(rename = "groupId")]
    pub group_id: Option<String>,
    pub capabilities: Vec<String>,
    pub state: String,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
    #[serde(rename = "lastSeenAt")]
    pub last_seen_at: f64,
    #[serde(rename = "lastSequence")]
    pub last_sequence: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingSessionPage {
    pub sessions: Vec<RoutingSession>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingSyncInputPublicationsItem {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub events: Vec<RoutingEventInput>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingSyncInputAcknowledgmentsItem {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingSyncInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publications: Option<Vec<RoutingSyncInputPublicationsItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acknowledgments: Option<Vec<RoutingSyncInputAcknowledgmentsItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inboxes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingSyncResultInboxesItem {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub messages: Vec<RoutingMessage>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingSyncResult {
    pub inboxes: Vec<RoutingSyncResultInboxesItem>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RunRuleRequest {
    pub id: String,
    pub expected_version: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_at: Option<f64>,
}

pub type RuntimeControl = Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RuntimeRequest {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RuntimeResponse {
    pub state: Option<RuntimeState>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RuntimeStateAdaptersItem {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RuntimeState {
    pub version: f64,
    pub role: String,
    pub status: String,
    pub mode: String,
    pub adapter: String,
    #[serde(rename = "supervisorId")]
    pub supervisor_id: String,
    pub cwd: String,
    #[serde(rename = "nativeSessionId", skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Reasoning depth the run was launched with (off, minimal, low, medium, high, xhigh).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(rename = "resumeSupported", skip_serializing_if = "Option::is_none")]
    pub resume_supported: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<RuntimeRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapters: Option<Vec<RuntimeStateAdaptersItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(rename = "activeCount", skip_serializing_if = "Option::is_none")]
    pub active_count: Option<f64>,
    /// World account of a supervised resident run (`MARINA_SUPERVISED_RESIDENTS=on`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resident: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SaveCheckpointRequest {
    pub expected_version: f64,
    pub data: BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_cursor: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SaveRuleRequest {
    pub rule: MemoryRule,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SaveVocabularyRequest {
    pub expected_version: f64,
    pub definition: MemoryVocabularyDefinition,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SelectAttemptRequest {
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SendChannelRequest {
    #[serde(rename = "clientMessageId")]
    pub client_message_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SourceHeadersResponseSourcesItem {
    pub id: String,
    pub space_id: String,
    pub seq: f64,
    pub session_id: Option<String>,
    pub content_hash: String,
    pub created_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SourceHeadersResponse {
    pub sources: Vec<SourceHeadersResponseSourcesItem>,
    pub next_cursor: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SourcesResponse {
    pub sources: Vec<MemorySource>,
    pub next_cursor: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SpacesResponse {
    pub spaces: Vec<MemorySpace>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StartInvestigationRequestLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calls: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<f64>,
    #[serde(rename = "timeoutMs", skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StartInvestigationRequest {
    pub kind: InvestigationKind,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<PredictionShape>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub horizon: Option<String>,
    #[serde(rename = "asOf", skip_serializing_if = "Option::is_none")]
    pub as_of: Option<String>,
    /// Existing case for a new attempt; prior results remain immutable.
    #[serde(rename = "caseId", skip_serializing_if = "Option::is_none")]
    pub case_id: Option<String>,
    /// An owned child while its parent runs; otherwise a new episode referencing prior work.
    #[serde(rename = "parentAttemptId", skip_serializing_if = "Option::is_none")]
    pub parent_attempt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<StartInvestigationRequestLimits>,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StartInvestigationResponse {
    pub attempt: InvestigationAttempt,
    pub created: bool,
}

/// A routing-only supervision credential (supervised residents).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SupervisionCredentialGrant {
    #[serde(rename = "credentialId")]
    pub credential_id: String,
    pub token: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkflowRequest {
    pub action: String,
}

pub type WorkflowResponse = BTreeMap<String, Value>;

/// Durable, versioned, cited memory. Spaces hold records (claims with versions and validity) and sources (raw evidence). Every write except the listed read-like POSTs needs an `Idempotency-Key`; resending the same key replays the first result.
///
/// The `memory` operations, typed. Derefs to [`HttpApi`] for `call` (anything newer).
#[derive(Clone)]
pub struct MemoryApi {
    http: HttpApi,
}

impl MemoryApi {
    /// Wrap an `HttpApi` (normally the SDK does this for you).
    pub fn new(http: HttpApi) -> Self {
        MemoryApi { http }
    }

    /// The untyped API underneath.
    pub fn http(&self) -> &HttpApi {
        &self.http
    }

    /// What this memory service offers
    ///
    /// `GET /v1/memory` (`capabilities`)
    pub fn capabilities(&self) -> Result<CapabilitiesResponse> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("capabilities", &params, None, None)?;
        from_reply(reply)
    }

    /// Who the presented credential is
    ///
    /// `GET /v1/memory/me` (`me`)
    pub fn me(&self) -> Result<MeResponse> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("me", &params, None, None)?;
        from_reply(reply)
    }

    /// Storage used and its limits
    ///
    /// `GET /v1/memory/usage` (`usage`)
    pub fn usage(&self) -> Result<MemoryStorageUsage> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("usage", &params, None, None)?;
        from_reply(reply)
    }

    /// Spaces this credential can read
    ///
    /// `GET /v1/memory/spaces` (`spaces`)
    pub fn spaces(&self) -> Result<SpacesResponse> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("spaces", &params, None, None)?;
        from_reply(reply)
    }

    /// Create a space
    ///
    /// `POST /v1/memory/spaces` (`createSpace`)
    pub fn create_space(&self, body: &CreateSpaceRequest, idempotency_key: Option<&str>) -> Result<MemoryReceipt> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("createSpace", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// One space
    ///
    /// `GET /v1/memory/spaces/{space}` (`space`)
    pub fn space(&self, space: &str) -> Result<MemorySpace> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("space", &params, None, None)?;
        from_reply(reply)
    }

    /// Write a record
    ///
    /// `POST /v1/memory/spaces/{space}/records` (`remember`)
    pub fn remember(&self, space: &str, body: &MemoryRecordInput, idempotency_key: Option<&str>) -> Result<MemoryReceipt> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("remember", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Read a record, or one of its earlier versions
    ///
    /// `GET /v1/memory/spaces/{space}/records/{id}` (`get`)
    pub fn get(&self, space: &str, id: &str, version: Option<f64>) -> Result<MemoryRecord> {
        let mut params: Vec<(&str, Value)> = vec![("space", Value::from(space)), ("id", Value::from(id))];
        if let Some(v) = version { params.push(("version", number(v))); }
        let reply = self.http.call_with_key("get", &params, None, None)?;
        from_reply(reply)
    }

    /// Revise a record (compare-and-set on its version)
    ///
    /// `PATCH /v1/memory/spaces/{space}/records/{id}` (`revise`)
    pub fn revise(&self, space: &str, id: &str, body: &ReviseRequest, idempotency_key: Option<&str>) -> Result<MemoryReceipt> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space)), ("id", Value::from(id))];
        let reply = self.http.call_with_key("revise", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Search records
    ///
    /// `POST /v1/memory/spaces/{space}/search` (`search`)
    pub fn search(&self, space: &str, body: &MemorySearchInput) -> Result<MemorySearchResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("search", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// A prompt-ready context block with citations, within a token budget
    ///
    /// `POST /v1/memory/spaces/{space}/context` (`context`)
    pub fn context(&self, space: &str, body: &ContextRequest) -> Result<ContextResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("context", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Structured query over claims
    ///
    /// `POST /v1/memory/spaces/{space}/query` (`query`)
    pub fn query(&self, space: &str, body: &MemoryQuery) -> Result<MemoryQueryResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("query", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Walk the claim graph from a subject
    ///
    /// `POST /v1/memory/spaces/{space}/graph` (`graph`)
    pub fn graph(&self, space: &str, body: &MemoryGraphQuery) -> Result<MemoryGraphResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("graph", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Join claim patterns
    ///
    /// `POST /v1/memory/spaces/{space}/join` (`join`)
    pub fn join(&self, space: &str, body: &MemoryJoin, idempotency_key: Option<&str>) -> Result<MemoryJoinResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("join", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Save an inference rule
    ///
    /// `POST /v1/memory/spaces/{space}/rules` (`saveRule`)
    pub fn save_rule(&self, space: &str, body: &SaveRuleRequest, idempotency_key: Option<&str>) -> Result<MemoryReceipt> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("saveRule", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Run a rule without writing
    ///
    /// `POST /v1/memory/spaces/{space}/rules/run` (`runRule`)
    pub fn run_rule(&self, space: &str, body: &RunRuleRequest, idempotency_key: Option<&str>) -> Result<MemoryRuleResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("runRule", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Run a rule and write what it infers
    ///
    /// `POST /v1/memory/spaces/{space}/rules/materialize` (`materializeRule`)
    pub fn materialize_rule(&self, space: &str, body: &MaterializeRuleRequest, idempotency_key: Option<&str>) -> Result<MaterializeRuleResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("materializeRule", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Entity/relation/observation graph operations
    ///
    /// `action` picks the operation; the other fields are that action's input (see MemoryGraphInputs).
    ///
    /// `POST /v1/memory/spaces/{space}/knowledge_graph` (`knowledgeGraph`)
    pub fn knowledge_graph(&self, space: &str, body: &KnowledgeGraphRequest) -> Result<KnowledgeGraphResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("knowledgeGraph", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Records that need a decision: stale, competing or pending
    ///
    /// `POST /v1/memory/spaces/{space}/review` (`review`)
    pub fn review(&self, space: &str, body: &ReviewRequest) -> Result<MemoryReviewResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("review", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Confirm a stale record still holds against its dependencies
    ///
    /// `POST /v1/memory/spaces/{space}/reaffirm` (`reaffirm`)
    pub fn reaffirm(&self, space: &str, body: &ReaffirmRequest, idempotency_key: Option<&str>) -> Result<MemoryReceipt> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("reaffirm", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Settle a contradiction: keep the head, close its rivals
    ///
    /// `POST /v1/memory/spaces/{space}/resolve` (`resolve`)
    pub fn resolve(&self, space: &str, body: &ResolveRequest, idempotency_key: Option<&str>) -> Result<MemoryResolveResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("resolve", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Adopt an answered assistance proposal into this space
    ///
    /// `POST /v1/memory/spaces/{space}/adopt` (`adopt`)
    pub fn adopt(&self, space: &str, body: &MemoryAdoptInput, idempotency_key: Option<&str>) -> Result<MemoryAdoptResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("adopt", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Acknowledge change notifications by key
    ///
    /// `POST /v1/memory/spaces/{space}/acknowledge` (`acknowledge`)
    pub fn acknowledge(&self, space: &str, body: &AcknowledgeRequest, idempotency_key: Option<&str>) -> Result<AcknowledgeResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("acknowledge", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Erase records or sources
    ///
    /// `POST /v1/memory/spaces/{space}/forget` (`forget`)
    pub fn forget(&self, space: &str, body: &ForgetMemoryInput, idempotency_key: Option<&str>) -> Result<MemoryReceipt> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("forget", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Give a principal read or write access (null removes it)
    ///
    /// `POST /v1/memory/spaces/{space}/grants` (`grant`)
    pub fn grant(&self, space: &str, body: &GrantRequest, idempotency_key: Option<&str>) -> Result<MemoryReceipt> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("grant", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Re-embed records, one page at a time
    ///
    /// `POST /v1/memory/spaces/{space}/reindex` (`reindex`)
    pub fn reindex(&self, space: &str, body: &ReindexRequest, idempotency_key: Option<&str>) -> Result<ReindexResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("reindex", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Read a cached derived value, if still valid
    ///
    /// `POST /v1/memory/spaces/{space}/cache/get` (`cacheGet`)
    pub fn cache_get(&self, space: &str, body: &MemoryCacheInput) -> Result<MemoryCacheResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("cacheGet", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Cache a derived value pinned to the records and sources it used
    ///
    /// `POST /v1/memory/spaces/{space}/cache/put` (`cachePut`)
    pub fn cache_put(&self, space: &str, body: &MemoryCacheWrite, idempotency_key: Option<&str>) -> Result<MemoryReceipt> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("cachePut", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Drop a cached value
    ///
    /// `POST /v1/memory/spaces/{space}/cache/delete` (`cacheDelete`)
    pub fn cache_delete(&self, space: &str, body: &MemoryCacheInput, idempotency_key: Option<&str>) -> Result<CacheDeleteResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("cacheDelete", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Plan the retrieval steps for a task
    ///
    /// `POST /v1/memory/spaces/{space}/plan` (`plan`)
    pub fn plan(&self, space: &str, body: &PlanRequest) -> Result<MemoryPlan> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("plan", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Run a retrieval plan
    ///
    /// `POST /v1/memory/spaces/{space}/execute_plan` (`executePlan`)
    pub fn execute_plan(&self, space: &str, body: &MemoryPlan) -> Result<MemoryPlanResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("executePlan", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Find and read citable evidence in one bounded request
    ///
    /// `POST /v1/memory/spaces/{space}/retrieve` (`retrieve`)
    pub fn retrieve(&self, space: &str, body: &MemoryRetrievalInput) -> Result<MemoryRetrievalResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("retrieve", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Retrieve, reusing a cached result while its evidence is unchanged
    ///
    /// `POST /v1/memory/spaces/{space}/retrieve_cached` (`retrieveCached`)
    pub fn retrieve_cached(&self, space: &str, body: &MemoryCachedRetrievalInput) -> Result<MemoryCachedRetrievalResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("retrieveCached", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Retrieve across mounted peer spaces
    ///
    /// `POST /v1/memory/spaces/{space}/federated_retrieve` (`federatedRetrieve`)
    pub fn federated_retrieve(&self, space: &str, body: &FederatedRetrieveRequest) -> Result<MemoryFederatedRetrievalResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("federatedRetrieve", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Peer spaces this principal can search
    ///
    /// `GET /v1/memory/spaces/{space}/federation_mounts` (`federationMounts`)
    pub fn federation_mounts(&self, space: &str) -> Result<FederationMountsResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("federationMounts", &params, None, None)?;
        from_reply(reply)
    }

    /// Search mounted peer spaces
    ///
    /// `POST /v1/memory/spaces/{space}/federated_search` (`federatedSearch`)
    pub fn federated_search(&self, space: &str, body: &MemoryFederatedSearch) -> Result<MemoryFederatedResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("federatedSearch", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Read one item from a mounted peer space
    ///
    /// `POST /v1/memory/spaces/{space}/federated_read` (`federatedRead`)
    pub fn federated_read(&self, space: &str, body: &MemoryFederatedRead) -> Result<FederatedReadResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("federatedRead", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// The space's vocabulary (current, or a version)
    ///
    /// `GET /v1/memory/spaces/{space}/vocabulary` (`vocabulary`)
    pub fn vocabulary(&self, space: &str, version: Option<f64>) -> Result<MemoryVocabulary> {
        let mut params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        if let Some(v) = version { params.push(("version", number(v))); }
        let reply = self.http.call_with_key("vocabulary", &params, None, None)?;
        from_reply(reply)
    }

    /// Replace the vocabulary (compare-and-set on its version)
    ///
    /// `POST /v1/memory/spaces/{space}/vocabulary` (`saveVocabulary`)
    pub fn save_vocabulary(&self, space: &str, body: &SaveVocabularyRequest, idempotency_key: Option<&str>) -> Result<MemoryReceipt> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("saveVocabulary", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Capture a source (raw evidence)
    ///
    /// `POST /v1/memory/spaces/{space}/sources` (`capture`)
    pub fn capture(&self, space: &str, body: &CaptureRequest, idempotency_key: Option<&str>) -> Result<MemoryReceipt> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("capture", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Sources after a cursor, oldest first
    ///
    /// `GET /v1/memory/spaces/{space}/sources` (`sources`)
    pub fn sources(&self, space: &str, after: Option<f64>, limit: Option<f64>) -> Result<SourcesResponse> {
        let mut params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        if let Some(v) = after { params.push(("after", number(v))); }
        if let Some(v) = limit { params.push(("limit", number(v))); }
        let reply = self.http.call_with_key("sources", &params, None, None)?;
        from_reply(reply)
    }

    /// Capture several sources, each with its own key
    ///
    /// `POST /v1/memory/spaces/{space}/sources/batch` (`captureBatch`)
    pub fn capture_batch(&self, space: &str, body: &CaptureBatchRequest, idempotency_key: Option<&str>) -> Result<CaptureBatchResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("captureBatch", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Source headers (no bodies) after a cursor
    ///
    /// `GET /v1/memory/spaces/{space}/source_headers` (`sourceHeaders`)
    pub fn source_headers(&self, space: &str, after: Option<f64>, limit: Option<f64>) -> Result<SourceHeadersResponse> {
        let mut params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        if let Some(v) = after { params.push(("after", number(v))); }
        if let Some(v) = limit { params.push(("limit", number(v))); }
        let reply = self.http.call_with_key("sourceHeaders", &params, None, None)?;
        from_reply(reply)
    }

    /// Read a range of a source
    ///
    /// `GET /v1/memory/spaces/{space}/sources/{id}` (`sourceRange`)
    pub fn source_range(&self, space: &str, id: &str, start: Option<f64>, end: Option<f64>, text_hash: Option<&str>) -> Result<MemorySourceRange> {
        let mut params: Vec<(&str, Value)> = vec![("space", Value::from(space)), ("id", Value::from(id))];
        if let Some(v) = start { params.push(("start", number(v))); }
        if let Some(v) = end { params.push(("end", number(v))); }
        if let Some(v) = text_hash { params.push(("text_hash", Value::from(v))); }
        let reply = self.http.call_with_key("sourceRange", &params, None, None)?;
        from_reply(reply)
    }

    /// Search source text
    ///
    /// `POST /v1/memory/spaces/{space}/source_search` (`sourceSearch`)
    pub fn source_search(&self, space: &str, body: &MemorySourceSearch) -> Result<MemorySourceSearchResult> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("sourceSearch", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Read a named checkpoint
    ///
    /// `GET /v1/memory/spaces/{space}/checkpoints/{name}` (`checkpoint`)
    pub fn checkpoint(&self, space: &str, name: &str) -> Result<MemoryCheckpoint> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space)), ("name", Value::from(name))];
        let reply = self.http.call_with_key("checkpoint", &params, None, None)?;
        from_reply(reply)
    }

    /// Save a named checkpoint (compare-and-set on its version)
    ///
    /// `POST /v1/memory/spaces/{space}/checkpoints/{name}` (`saveCheckpoint`)
    pub fn save_checkpoint(&self, space: &str, name: &str, body: &SaveCheckpointRequest, idempotency_key: Option<&str>) -> Result<MemoryReceipt> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space)), ("name", Value::from(name))];
        let reply = self.http.call_with_key("saveCheckpoint", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Capture sources and the checkpoint naming them in one transaction
    ///
    /// `POST /v1/memory/spaces/{space}/checkpoints/{name}/capture` (`captureCheckpoint`)
    pub fn capture_checkpoint(&self, space: &str, name: &str, body: &MemoryCheckpointCapture, idempotency_key: Option<&str>) -> Result<MemoryCheckpointCaptureReceipt> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space)), ("name", Value::from(name))];
        let reply = self.http.call_with_key("captureCheckpoint", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Export the space as one bundle
    ///
    /// `GET /v1/memory/spaces/{space}/bundle` (`exportBundle`)
    pub fn export_bundle(&self, space: &str) -> Result<MemoryBundle> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("exportBundle", &params, None, None)?;
        from_reply(reply)
    }

    /// Import a bundle into the space
    ///
    /// `POST /v1/memory/spaces/{space}/bundle` (`importBundle`)
    pub fn import_bundle(&self, space: &str, body: &MemoryBundle, idempotency_key: Option<&str>) -> Result<ImportBundleResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("importBundle", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Export the space page by page
    ///
    /// `GET /v1/memory/spaces/{space}/transfer` (`exportTransferPage`)
    pub fn export_transfer_page(&self, space: &str, cursor: Option<&str>) -> Result<MemoryTransferPage> {
        let mut params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        if let Some(v) = cursor { params.push(("cursor", Value::from(v))); }
        let reply = self.http.call_with_key("exportTransferPage", &params, None, None)?;
        from_reply(reply)
    }

    /// Begin a paged import
    ///
    /// `POST /v1/memory/spaces/{space}/transfers` (`beginTransfer`)
    pub fn begin_transfer(&self, space: &str, body: &MemoryTransferHeader, idempotency_key: Option<&str>) -> Result<MemoryTransferStatus> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("beginTransfer", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Paged imports into this space
    ///
    /// `GET /v1/memory/spaces/{space}/transfers` (`transfers`)
    pub fn transfers(&self, space: &str, state: Option<&str>, limit: Option<f64>, cursor: Option<&str>) -> Result<MemoryTransferList> {
        let mut params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        if let Some(v) = state { params.push(("state", Value::from(v))); }
        if let Some(v) = limit { params.push(("limit", number(v))); }
        if let Some(v) = cursor { params.push(("cursor", Value::from(v))); }
        let reply = self.http.call_with_key("transfers", &params, None, None)?;
        from_reply(reply)
    }

    /// One paged import
    ///
    /// `GET /v1/memory/spaces/{space}/transfers/{id}` (`transferStatus`)
    pub fn transfer_status(&self, space: &str, id: &str) -> Result<MemoryTransferStatus> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space)), ("id", Value::from(id))];
        let reply = self.http.call_with_key("transferStatus", &params, None, None)?;
        from_reply(reply)
    }

    /// Add a page to a paged import
    ///
    /// `POST /v1/memory/spaces/{space}/transfers/{id}/pages` (`appendTransfer`)
    pub fn append_transfer(&self, space: &str, id: &str, body: &MemoryTransferPage, idempotency_key: Option<&str>) -> Result<MemoryTransferStatus> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space)), ("id", Value::from(id))];
        let reply = self.http.call_with_key("appendTransfer", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Commit a paged import, checked against its hash
    ///
    /// `POST /v1/memory/spaces/{space}/transfers/{id}/commit` (`commitTransfer`)
    pub fn commit_transfer(&self, space: &str, id: &str, body: &CommitTransferRequest, idempotency_key: Option<&str>) -> Result<CommitTransferResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space)), ("id", Value::from(id))];
        let reply = self.http.call_with_key("commitTransfer", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Abandon a paged import
    ///
    /// `POST /v1/memory/spaces/{space}/transfers/{id}/abort` (`abortTransfer`)
    pub fn abort_transfer(&self, space: &str, id: &str, body: &AbortTransferRequest, idempotency_key: Option<&str>) -> Result<MemoryReceipt> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space)), ("id", Value::from(id))];
        let reply = self.http.call_with_key("abortTransfer", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Everything in the space as JSON
    ///
    /// `GET /v1/memory/spaces/{space}/export` (`export`)
    pub fn export(&self, space: &str) -> Result<ExportResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("export", &params, None, None)?;
        from_reply(reply)
    }

    /// An index job (a receipt's job_id)
    ///
    /// `GET /v1/memory/spaces/{space}/jobs/{id}` (`job`)
    pub fn job(&self, space: &str, id: &str) -> Result<MemoryJobStatus> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space)), ("id", Value::from(id))];
        let reply = self.http.call_with_key("job", &params, None, None)?;
        from_reply(reply)
    }

    /// Key-value JSON documents in namespaces, as one atomic batch (1-64 operations)
    ///
    /// Each operation is one of: read (`namespace` + `key`), write (`value`; `null` deletes), search (`namespacePrefix`, optional `query`/`filter`), or list namespaces (`matchConditions`). `results` has one entry per operation, in order.
    ///
    /// `POST /v1/memory/spaces/{space}/json_store` (`jsonStore`)
    pub fn json_store(&self, space: &str, body: &JsonStoreRequest, idempotency_key: Option<&str>) -> Result<JsonStoreResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("jsonStore", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Task workflows over memory: start, run, finish, resume, recipes, watches
    ///
    /// `action` picks the operation; the other fields are its input.
    ///
    /// `POST /v1/memory/spaces/{space}/workflow` (`workflow`)
    pub fn workflow(&self, space: &str, body: &WorkflowRequest) -> Result<WorkflowResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("workflow", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Ask a helper for memory work
    ///
    /// `POST /v1/memory/spaces/{space}/assistance` (`assistCreate`)
    pub fn assist_create(&self, space: &str, body: &MemoryAssistanceInput, idempotency_key: Option<&str>) -> Result<AssistCreateResponse> {
        let params: Vec<(&str, Value)> = vec![("space", Value::from(space))];
        let reply = self.http.call_with_key("assistCreate", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Assistance jobs for this principal
    ///
    /// `GET /v1/memory/assistance` (`assistJobs`)
    pub fn assist_jobs(&self, open: Option<bool>, limit: Option<f64>, cursor: Option<&str>) -> Result<MemoryAssistancePage> {
        let mut params: Vec<(&str, Value)> = Vec::new();
        if let Some(v) = open { params.push(("open", Value::from(v))); }
        if let Some(v) = limit { params.push(("limit", number(v))); }
        if let Some(v) = cursor { params.push(("cursor", Value::from(v))); }
        let reply = self.http.call_with_key("assistJobs", &params, None, None)?;
        from_reply(reply)
    }

    /// One assistance job
    ///
    /// `GET /v1/memory/assistance/{job}` (`assistGet`)
    pub fn assist_get(&self, job: &str) -> Result<MemoryAssistanceJob> {
        let params: Vec<(&str, Value)> = vec![("job", Value::from(job))];
        let reply = self.http.call_with_key("assistGet", &params, None, None)?;
        from_reply(reply)
    }

    /// Claim a job (as its worker); returns a lease
    ///
    /// `POST /v1/memory/assistance/{job}/claim` (`assistClaim`)
    pub fn assist_claim(&self, job: &str, body: &AssistClaimRequest, idempotency_key: Option<&str>) -> Result<AssistClaimResponse> {
        let params: Vec<(&str, Value)> = vec![("job", Value::from(job))];
        let reply = self.http.call_with_key("assistClaim", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Extend the lease
    ///
    /// `POST /v1/memory/assistance/{job}/heartbeat` (`assistHeartbeat`)
    pub fn assist_heartbeat(&self, job: &str, body: &AssistHeartbeatRequest, idempotency_key: Option<&str>) -> Result<AssistHeartbeatResponse> {
        let params: Vec<(&str, Value)> = vec![("job", Value::from(job))];
        let reply = self.http.call_with_key("assistHeartbeat", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Run one read operation inside the job's scope
    ///
    /// `POST /v1/memory/assistance/{job}/read` (`assistRead`)
    pub fn assist_read(&self, job: &str, body: &AssistReadRequest, idempotency_key: Option<&str>) -> Result<AssistReadResponse> {
        let params: Vec<(&str, Value)> = vec![("job", Value::from(job))];
        let reply = self.http.call_with_key("assistRead", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Finish with an answer (cited) or an abstention
    ///
    /// `POST /v1/memory/assistance/{job}/finish` (`assistFinish`)
    pub fn assist_finish(&self, job: &str, body: &AssistFinishRequest, idempotency_key: Option<&str>) -> Result<AssistFinishResponse> {
        let params: Vec<(&str, Value)> = vec![("job", Value::from(job))];
        let reply = self.http.call_with_key("assistFinish", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Cancel a job
    ///
    /// `POST /v1/memory/assistance/{job}/cancel` (`assistCancel`)
    pub fn assist_cancel(&self, job: &str, body: &AssistCancelRequest, idempotency_key: Option<&str>) -> Result<AssistCancelResponse> {
        let params: Vec<(&str, Value)> = vec![("job", Value::from(job))];
        let reply = self.http.call_with_key("assistCancel", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Hand part of the job to another helper
    ///
    /// `POST /v1/memory/assistance/{job}/delegate` (`assistDelegate`)
    pub fn assist_delegate(&self, job: &str, body: &AssistDelegateRequest, idempotency_key: Option<&str>) -> Result<AssistDelegateResponse> {
        let params: Vec<(&str, Value)> = vec![("job", Value::from(job))];
        let reply = self.http.call_with_key("assistDelegate", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }

    /// Adopt the job's answer into its own space
    ///
    /// `POST /v1/memory/assistance/{job}/adopt` (`assistAdopt`)
    pub fn assist_adopt(&self, job: &str, body: &AssistAdoptRequest, idempotency_key: Option<&str>) -> Result<MemoryAdoptResult> {
        let params: Vec<(&str, Value)> = vec![("job", Value::from(job))];
        let reply = self.http.call_with_key("assistAdopt", &params, Some(to_body(body)?), idempotency_key)?;
        from_reply(reply)
    }
}

impl std::ops::Deref for MemoryApi {
    type Target = HttpApi;
    fn deref(&self) -> &HttpApi {
        &self.http
    }
}

/// Participant routing: join as a session, publish output, message other sessions, read channels, and supervise native agent runtimes.
///
/// The `routing` operations, typed. Derefs to [`HttpApi`] for `call` (anything newer).
#[derive(Clone)]
pub struct RoutingApi {
    http: HttpApi,
}

impl RoutingApi {
    /// Wrap an `HttpApi` (normally the SDK does this for you).
    pub fn new(http: HttpApi) -> Self {
        RoutingApi { http }
    }

    /// The untyped API underneath.
    pub fn http(&self) -> &HttpApi {
        &self.http
    }

    /// Join as a routed participant session
    ///
    /// `POST /api/routing/sessions` (`joinSession`)
    pub fn join_session(&self, body: &RoutingJoin) -> Result<RoutingSession> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("joinSession", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Sessions you can see
    ///
    /// `GET /api/routing/sessions` (`discover`)
    pub fn discover(&self, after: Option<&str>, limit: Option<f64>) -> Result<RoutingSessionPage> {
        let mut params: Vec<(&str, Value)> = Vec::new();
        if let Some(v) = after { params.push(("after", Value::from(v))); }
        if let Some(v) = limit { params.push(("limit", number(v))); }
        let reply = self.http.call_with_key("discover", &params, None, None)?;
        from_reply(reply)
    }

    /// Sessions with their latest activity
    ///
    /// `GET /api/routing/overview` (`overview`)
    pub fn overview(&self, after: Option<&str>, limit: Option<f64>, attention: Option<bool>) -> Result<RoutingOverview> {
        let mut params: Vec<(&str, Value)> = Vec::new();
        if let Some(v) = after { params.push(("after", Value::from(v))); }
        if let Some(v) = limit { params.push(("limit", number(v))); }
        if let Some(v) = attention { params.push(("attention", Value::from(v))); }
        let reply = self.http.call_with_key("overview", &params, None, None)?;
        from_reply(reply)
    }

    /// One session
    ///
    /// `GET /api/routing/sessions/{session}` (`session`)
    pub fn session(&self, session: &str) -> Result<RoutingSession> {
        let params: Vec<(&str, Value)> = vec![("session", Value::from(session))];
        let reply = self.http.call_with_key("session", &params, None, None)?;
        from_reply(reply)
    }

    /// Keep the session live
    ///
    /// `POST /api/routing/sessions/{session}/heartbeat` (`heartbeat`)
    pub fn heartbeat(&self, session: &str, body: &HeartbeatRequest) -> Result<RoutingSession> {
        let params: Vec<(&str, Value)> = vec![("session", Value::from(session))];
        let reply = self.http.call_with_key("heartbeat", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// End the session
    ///
    /// `POST /api/routing/sessions/{session}/leave` (`leave`)
    pub fn leave(&self, session: &str, body: &LeaveRequest) -> Result<RoutingSession> {
        let params: Vec<(&str, Value)> = vec![("session", Value::from(session))];
        let reply = self.http.call_with_key("leave", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Publish output events
    ///
    /// `POST /api/routing/sessions/{session}/events` (`publish`)
    pub fn publish(&self, session: &str, body: &PublishRequest) -> Result<PublishResponse> {
        let params: Vec<(&str, Value)> = vec![("session", Value::from(session))];
        let reply = self.http.call_with_key("publish", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Events after a cursor (poll this to watch)
    ///
    /// `GET /api/routing/sessions/{session}/events` (`events`)
    pub fn events(&self, session: &str, after: Option<f64>, limit: Option<f64>) -> Result<RoutingEventPage> {
        let mut params: Vec<(&str, Value)> = vec![("session", Value::from(session))];
        if let Some(v) = after { params.push(("after", number(v))); }
        if let Some(v) = limit { params.push(("limit", number(v))); }
        let reply = self.http.call_with_key("events", &params, None, None)?;
        from_reply(reply)
    }

    /// Send a message to another session
    ///
    /// `POST /api/routing/sessions/{session}/messages` (`send`)
    pub fn send(&self, session: &str, body: &RoutingSend) -> Result<RoutingMessage> {
        let params: Vec<(&str, Value)> = vec![("session", Value::from(session))];
        let reply = self.http.call_with_key("send", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Messages waiting for this session
    ///
    /// `GET /api/routing/sessions/{session}/inbox` (`inbox`)
    pub fn inbox(&self, session: &str, limit: Option<f64>) -> Result<InboxResponse> {
        let mut params: Vec<(&str, Value)> = vec![("session", Value::from(session))];
        if let Some(v) = limit { params.push(("limit", number(v))); }
        let reply = self.http.call_with_key("inbox", &params, None, None)?;
        from_reply(reply)
    }

    /// Messages this session sent, with delivery state
    ///
    /// `GET /api/routing/sessions/{session}/deliveries` (`deliveries`)
    pub fn deliveries(&self, session: &str, limit: Option<f64>) -> Result<DeliveriesResponse> {
        let mut params: Vec<(&str, Value)> = vec![("session", Value::from(session))];
        if let Some(v) = limit { params.push(("limit", number(v))); }
        let reply = self.http.call_with_key("deliveries", &params, None, None)?;
        from_reply(reply)
    }

    /// One message's delivery state
    ///
    /// `GET /api/routing/sessions/{session}/messages/{message}` (`receipt`)
    pub fn receipt(&self, session: &str, message: &str) -> Result<RoutingMessage> {
        let params: Vec<(&str, Value)> = vec![("session", Value::from(session)), ("message", Value::from(message))];
        let reply = self.http.call_with_key("receipt", &params, None, None)?;
        from_reply(reply)
    }

    /// Acknowledge a received message
    ///
    /// `POST /api/routing/sessions/{session}/messages/{message}/ack` (`acknowledgeMessage`)
    pub fn acknowledge_message(&self, session: &str, message: &str, body: &AcknowledgeMessageRequest) -> Result<RoutingMessage> {
        let params: Vec<(&str, Value)> = vec![("session", Value::from(session)), ("message", Value::from(message))];
        let reply = self.http.call_with_key("acknowledgeMessage", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// World channels this session can use
    ///
    /// `GET /api/routing/sessions/{session}/channels` (`channels`)
    pub fn channels(&self, session: &str) -> Result<ChannelsResponse> {
        let params: Vec<(&str, Value)> = vec![("session", Value::from(session))];
        let reply = self.http.call_with_key("channels", &params, None, None)?;
        from_reply(reply)
    }

    /// Channel history after a cursor
    ///
    /// `GET /api/routing/sessions/{session}/channels/{channel}/messages` (`channelMessages`)
    pub fn channel_messages(&self, session: &str, channel: &str, after: Option<f64>, limit: Option<f64>) -> Result<RoutingChannelPage> {
        let mut params: Vec<(&str, Value)> = vec![("session", Value::from(session)), ("channel", Value::from(channel))];
        if let Some(v) = after { params.push(("after", number(v))); }
        if let Some(v) = limit { params.push(("limit", number(v))); }
        let reply = self.http.call_with_key("channelMessages", &params, None, None)?;
        from_reply(reply)
    }

    /// Post to a channel
    ///
    /// `POST /api/routing/sessions/{session}/channels/{channel}/messages` (`sendChannel`)
    pub fn send_channel(&self, session: &str, channel: &str, body: &SendChannelRequest) -> Result<RoutingChannelReceipt> {
        let params: Vec<(&str, Value)> = vec![("session", Value::from(session)), ("channel", Value::from(channel))];
        let reply = self.http.call_with_key("sendChannel", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Report a supervisor's runtimes and collect their controls
    ///
    /// `POST /api/routing/sync` (`sync`)
    pub fn sync(&self, body: &RoutingSyncInput) -> Result<RoutingSyncResult> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("sync", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// The session's supervised runtime state
    ///
    /// `GET /api/routing/sessions/{session}/runtime` (`runtime`)
    pub fn runtime(&self, session: &str) -> Result<RuntimeResponse> {
        let params: Vec<(&str, Value)> = vec![("session", Value::from(session))];
        let reply = self.http.call_with_key("runtime", &params, None, None)?;
        from_reply(reply)
    }

    /// Send a runtime control (steer, interrupt, stop…) to another session
    ///
    /// `POST /api/routing/sessions/{session}/control` (`control`)
    pub fn control(&self, session: &str, body: &ControlRequest) -> Result<RoutingMessage> {
        let params: Vec<(&str, Value)> = vec![("session", Value::from(session))];
        let reply = self.http.call_with_key("control", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Enrol a run's agent as its own world account
    ///
    /// `POST /api/routing/residents` (`enrolResident`)
    pub fn enrol_resident(&self, body: &ResidentEnrolInput) -> Result<ResidentEnrolment> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("enrolResident", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// A fresh credential for a live owned run
    ///
    /// `POST /api/routing/residents/{name}/renew` (`renewResident`)
    pub fn renew_resident(&self, name: &str, body: &RenewResidentRequest) -> Result<RenewResidentResponse> {
        let params: Vec<(&str, Value)> = vec![("name", Value::from(name))];
        let reply = self.http.call_with_key("renewResident", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// End this run's hold on the resident
    ///
    /// `POST /api/routing/residents/{name}/revoke` (`revokeResident`)
    pub fn revoke_resident(&self, name: &str, body: &RevokeResidentRequest) -> Result<RevokeResidentResponse> {
        let params: Vec<(&str, Value)> = vec![("name", Value::from(name))];
        let reply = self.http.call_with_key("revokeResident", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Report attention-bridge decisions and presence
    ///
    /// `POST /api/routing/residents/{name}/attention` (`reportResidentAttention`)
    pub fn report_resident_attention(&self, name: &str, body: &ResidentAttentionReport) -> Result<ReportResidentAttentionResponse> {
        let params: Vec<(&str, Value)> = vec![("name", Value::from(name))];
        let reply = self.http.call_with_key("reportResidentAttention", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Exchange a world session for a routing-only supervision credential
    ///
    /// `POST /api/routing/supervision` (`issueSupervision`)
    pub fn issue_supervision(&self, body: &IssueSupervisionRequest) -> Result<SupervisionCredentialGrant> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("issueSupervision", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Replace the presented supervision credential
    ///
    /// `POST /api/routing/supervision/renew` (`renewSupervision`)
    pub fn renew_supervision(&self, body: &RenewSupervisionRequest) -> Result<SupervisionCredentialGrant> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("renewSupervision", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Revoke the presented supervision credential
    ///
    /// `POST /api/routing/supervision/revoke` (`revokeSupervision`)
    pub fn revoke_supervision(&self, body: &RevokeSupervisionRequest) -> Result<RevokeSupervisionResponse> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("revokeSupervision", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }
}

impl std::ops::Deref for RoutingApi {
    type Target = HttpApi;
    fn deref(&self) -> &HttpApi {
        &self.http
    }
}

/// Investigations: a question run as a case with attempts, events, a selected answer, and (for predictions) a scored outcome.
///
/// The `investigations` operations, typed. Derefs to [`HttpApi`] for `call` (anything newer).
#[derive(Clone)]
pub struct InvestigationsApi {
    http: HttpApi,
}

impl InvestigationsApi {
    /// Wrap an `HttpApi` (normally the SDK does this for you).
    pub fn new(http: HttpApi) -> Self {
        InvestigationsApi { http }
    }

    /// The untyped API underneath.
    pub fn http(&self) -> &HttpApi {
        &self.http
    }

    /// Start an investigation (or replay the one this key started)
    ///
    /// `POST /api/investigations` (`startInvestigation`)
    pub fn start_investigation(&self, body: &StartInvestigationRequest) -> Result<StartInvestigationResponse> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("startInvestigation", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Your cases, newest first
    ///
    /// `GET /api/investigations` (`listInvestigations`)
    pub fn list_investigations(&self, before: Option<f64>) -> Result<ListInvestigationsResponse> {
        let mut params: Vec<(&str, Value)> = Vec::new();
        if let Some(v) = before { params.push(("before", number(v))); }
        let reply = self.http.call_with_key("listInvestigations", &params, None, None)?;
        from_reply(reply)
    }

    /// A case with its attempts (or one attempt of it)
    ///
    /// `GET /api/investigations/{case}` (`getInvestigation`)
    pub fn get_investigation(&self, case: &str, attempt: Option<&str>) -> Result<InvestigationSnapshot> {
        let mut params: Vec<(&str, Value)> = vec![("case", Value::from(case))];
        if let Some(v) = attempt { params.push(("attempt", Value::from(v))); }
        let reply = self.http.call_with_key("getInvestigation", &params, None, None)?;
        from_reply(reply)
    }

    /// Erase a case
    ///
    /// `DELETE /api/investigations/{case}` (`eraseInvestigation`)
    pub fn erase_investigation(&self, case: &str) -> Result<EraseInvestigationResponse> {
        let params: Vec<(&str, Value)> = vec![("case", Value::from(case))];
        let reply = self.http.call_with_key("eraseInvestigation", &params, None, None)?;
        from_reply(reply)
    }

    /// Share a case (null access removes it)
    ///
    /// `POST /api/investigations/{case}/grants` (`grantInvestigation`)
    pub fn grant_investigation(&self, case: &str, body: &GrantInvestigationRequest) -> Result<GrantInvestigationResponse> {
        let params: Vec<(&str, Value)> = vec![("case", Value::from(case))];
        let reply = self.http.call_with_key("grantInvestigation", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// One attempt
    ///
    /// `GET /api/investigations/attempts/{attempt}` (`attempt`)
    pub fn attempt(&self, attempt: &str) -> Result<InvestigationAttempt> {
        let params: Vec<(&str, Value)> = vec![("attempt", Value::from(attempt))];
        let reply = self.http.call_with_key("attempt", &params, None, None)?;
        from_reply(reply)
    }

    /// An attempt's events after a cursor
    ///
    /// `GET /api/investigations/attempts/{attempt}/events` (`attemptEvents`)
    pub fn attempt_events(&self, attempt: &str, after: Option<f64>, limit: Option<f64>) -> Result<InvestigationEventPage> {
        let mut params: Vec<(&str, Value)> = vec![("attempt", Value::from(attempt))];
        if let Some(v) = after { params.push(("after", number(v))); }
        if let Some(v) = limit { params.push(("limit", number(v))); }
        let reply = self.http.call_with_key("attemptEvents", &params, None, None)?;
        from_reply(reply)
    }

    /// Cancel an attempt
    ///
    /// `POST /api/investigations/attempts/{attempt}/cancel` (`cancelAttempt`)
    pub fn cancel_attempt(&self, attempt: &str, body: &CancelAttemptRequest) -> Result<CancelAttemptResponse> {
        let params: Vec<(&str, Value)> = vec![("attempt", Value::from(attempt))];
        let reply = self.http.call_with_key("cancelAttempt", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Make this attempt the case's answer
    ///
    /// `POST /api/investigations/attempts/{attempt}/select` (`selectAttempt`)
    pub fn select_attempt(&self, attempt: &str, body: &SelectAttemptRequest) -> Result<InvestigationSnapshot> {
        let params: Vec<(&str, Value)> = vec![("attempt", Value::from(attempt))];
        let reply = self.http.call_with_key("selectAttempt", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Add a review note
    ///
    /// `POST /api/investigations/attempts/{attempt}/review` (`reviewAttempt`)
    pub fn review_attempt(&self, attempt: &str, body: &ReviewAttemptRequest) -> Result<InvestigationEvent> {
        let params: Vec<(&str, Value)> = vec![("attempt", Value::from(attempt))];
        let reply = self.http.call_with_key("reviewAttempt", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Record the real outcome; scores a prediction
    ///
    /// `POST /api/investigations/attempts/{attempt}/resolve` (`resolveAttempt`)
    pub fn resolve_attempt(&self, attempt: &str, body: &ResolveAttemptRequest) -> Result<ResolveAttemptResponse> {
        let params: Vec<(&str, Value)> = vec![("attempt", Value::from(attempt))];
        let reply = self.http.call_with_key("resolveAttempt", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Stored content an event refers to
    ///
    /// `GET /api/investigations/content/{content}` (`investigationContent`)
    pub fn investigation_content(&self, content: &str) -> Result<InvestigationContent> {
        let params: Vec<(&str, Value)> = vec![("content", Value::from(content))];
        let reply = self.http.call_with_key("investigationContent", &params, None, None)?;
        from_reply(reply)
    }
}

impl std::ops::Deref for InvestigationsApi {
    type Target = HttpApi;
    fn deref(&self) -> &HttpApi {
        &self.http
    }
}

/// Published panels: A2UI documents on a canvas that people and agents read and press. Live changes arrive on the `/dashboard-ws` WebSocket.
///
/// The `panels` operations, typed. Derefs to [`HttpApi`] for `call` (anything newer).
#[derive(Clone)]
pub struct PanelsApi {
    http: HttpApi,
}

impl PanelsApi {
    /// Wrap an `HttpApi` (normally the SDK does this for you).
    pub fn new(http: HttpApi) -> Self {
        PanelsApi { http }
    }

    /// The untyped API underneath.
    pub fn http(&self) -> &HttpApi {
        &self.http
    }

    /// Create a canvas to publish panels on
    ///
    /// `POST /api/canvases` (`createCanvas`)
    pub fn create_canvas(&self, body: &CreateCanvasRequest) -> Result<CreateCanvasResponse> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("createCanvas", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Canvases you can see
    ///
    /// `GET /api/canvases` (`canvases`)
    pub fn canvases(&self, limit: Option<f64>) -> Result<CanvasesResponse> {
        let mut params: Vec<(&str, Value)> = Vec::new();
        if let Some(v) = limit { params.push(("limit", number(v))); }
        let reply = self.http.call_with_key("canvases", &params, None, None)?;
        from_reply(reply)
    }

    /// Live data a panel can bind to
    ///
    /// `GET /api/panel-resources` (`panelResources`)
    pub fn panel_resources(&self) -> Result<PanelResourcesResponse> {
        let params: Vec<(&str, Value)> = Vec::new();
        let reply = self.http.call_with_key("panelResources", &params, None, None)?;
        from_reply(reply)
    }

    /// A canvas with its nodes (panels are type `a2ui`)
    ///
    /// `GET /api/canvases/{canvas}` (`canvas`)
    pub fn canvas(&self, canvas: &str) -> Result<CanvasResponse> {
        let params: Vec<(&str, Value)> = vec![("canvas", Value::from(canvas))];
        let reply = self.http.call_with_key("canvas", &params, None, None)?;
        from_reply(reply)
    }

    /// Publish a panel
    ///
    /// `POST /api/canvases/{canvas}/nodes` (`publishPanel`)
    pub fn publish_panel(&self, canvas: &str, body: &PublishPanelRequest) -> Result<PublishedPanelNode> {
        let params: Vec<(&str, Value)> = vec![("canvas", Value::from(canvas))];
        let reply = self.http.call_with_key("publishPanel", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// One panel
    ///
    /// `GET /api/canvases/{canvas}/nodes/{node}` (`panel`)
    pub fn panel(&self, canvas: &str, node: &str) -> Result<PublishedPanelNode> {
        let params: Vec<(&str, Value)> = vec![("canvas", Value::from(canvas)), ("node", Value::from(node))];
        let reply = self.http.call_with_key("panel", &params, None, None)?;
        from_reply(reply)
    }

    /// Replace a panel's document (409 if `revision` is stale)
    ///
    /// `PATCH /api/canvases/{canvas}/nodes/{node}` (`revisePanel`)
    pub fn revise_panel(&self, canvas: &str, node: &str, body: &RevisePanelRequest) -> Result<PublishedPanelNode> {
        let params: Vec<(&str, Value)> = vec![("canvas", Value::from(canvas)), ("node", Value::from(node))];
        let reply = self.http.call_with_key("revisePanel", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }

    /// Press a panel's button or submit its form
    ///
    /// `POST /api/canvases/{canvas}/nodes/{node}/interaction` (`interactPanel`)
    pub fn interact_panel(&self, canvas: &str, node: &str, body: &PanelInteractionInput) -> Result<InteractPanelResponse> {
        let params: Vec<(&str, Value)> = vec![("canvas", Value::from(canvas)), ("node", Value::from(node))];
        let reply = self.http.call_with_key("interactPanel", &params, Some(to_body(body)?), None)?;
        from_reply(reply)
    }
}

impl std::ops::Deref for PanelsApi {
    type Target = HttpApi;
    fn deref(&self) -> &HttpApi {
        &self.http
    }
}
