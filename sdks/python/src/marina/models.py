# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Typed models and methods for every marina.http.v1 operation (marina.http.v1).

Generated from protocol/marina.http.v1.openapi.json by scripts/sdk-models/python.ts
(`bun run docs:api`); do not edit by hand. Each component schema is a TypedDict (objects) or
a type alias (unions, enums); each tag is a class whose methods take path parameters
positionally, query parameters by keyword and the JSON body as `body`.
"""

from __future__ import annotations

import sys
from typing import Any, Literal, Optional, TypedDict, Union

from ._operations import OPERATIONS, Operation
from .http import HttpApi, TokenSource

if sys.version_info >= (3, 11):
    from typing import NotRequired  # noqa: F401 - read by type checkers in annotations

_BY_ID = {op.id: op for op in OPERATIONS.values()}


def _operation(operation_id: str) -> Operation:
    return _BY_ID[operation_id]


# ─── Models ───────────────────────────────────────────────────────────────

A2UIComponent = TypedDict(
    "A2UIComponent",
    {
        "id": "str",
        "component": "A2UIComponentType",
        "child": "NotRequired[str]",
        "children": "NotRequired[list[str]]",
    },
)

A2UINodeDataLastAction = TypedDict(
    "A2UINodeDataLastAction",
    {
        "name": "str",
        "payload": "NotRequired[dict[str, Any]]",
        "timestamp": "float",
    },
)

A2UINodeData = TypedDict(
    "A2UINodeData",
    {
        "schema": "NotRequired[Literal['marina.panel.v1']]",
        "components": "list[A2UIComponent]",
        "rootId": "NotRequired[str]",
        "dataModel": "NotRequired[dict[str, Any]]",
        "sources": "NotRequired[dict[str, PanelSource]]",
        "title": "NotRequired[str]",
        "lastAction": "NotRequired[A2UINodeDataLastAction]",
    },
)

AcknowledgeRequest = TypedDict(
    "AcknowledgeRequest",
    {
        "keys": "list[str]",
    },
)

AcknowledgeResponse = TypedDict(
    "AcknowledgeResponse",
    {
        "acknowledged": "list[str]",
        "missing": "list[str]",
    },
)

# A routing or investigations failure.
ApiError = TypedDict(
    "ApiError",
    {
        "error": "str",
        "code": "NotRequired[str]",
    },
)

AssistAdoptRequest = TypedDict(
    "AssistAdoptRequest",
    {
        "target_space_id": "NotRequired[str]",
        "rationale": "NotRequired[str]",
        "valid_time": "NotRequired[Optional[MemoryValidity]]",
        "confirm_abstention": "NotRequired[bool]",
    },
)

AssistCancelResponse = TypedDict(
    "AssistCancelResponse",
    {
        "id": "str",
        "state": "Literal['pending', 'running', 'answered', 'abstained', 'cancelled', 'expired']",
    },
)

AssistClaimResponse = TypedDict(
    "AssistClaimResponse",
    {
        "id": "str",
        "lease_token": "str",
        "lease_until": "float",
    },
)

AssistCreateResponse = TypedDict(
    "AssistCreateResponse",
    {
        "id": "str",
    },
)

AssistDelegateRequest = TypedDict(
    "AssistDelegateRequest",
    {
        "worker_id": "str",
        "role": "MemoryHelperRole",
        "task": "str",
        "lease_token": "str",
    },
)

AssistDelegateResponse = TypedDict(
    "AssistDelegateResponse",
    {
        "id": "str",
    },
)

AssistFinishRequest = TypedDict(
    "AssistFinishRequest",
    {
        "lease_token": "str",
        "completion": "MemoryAnswer",
    },
)

AssistFinishResponse = TypedDict(
    "AssistFinishResponse",
    {
        "id": "str",
        "state": "Literal['pending', 'running', 'answered', 'abstained', 'cancelled', 'expired']",
        "result_record_id": "str",
    },
)

AssistHeartbeatRequest = TypedDict(
    "AssistHeartbeatRequest",
    {
        "lease_token": "str",
    },
)

AssistHeartbeatResponse = TypedDict(
    "AssistHeartbeatResponse",
    {
        "id": "str",
        "lease_until": "float",
    },
)

AssistReadRequestRequest = TypedDict(
    "AssistReadRequestRequest",
    {
        "operation": "str",
        "id": "NotRequired[str]",
        "input": "NotRequired[dict[str, Any]]",
    },
)

AssistReadRequest = TypedDict(
    "AssistReadRequest",
    {
        "lease_token": "str",
        "request": "AssistReadRequestRequest",
    },
)

CacheDeleteResponse = TypedDict(
    "CacheDeleteResponse",
    {
        "id": "str",
        "version": "NotRequired[float]",
        "job_id": "NotRequired[str]",
        "seq": "NotRequired[float]",
        "generation": "NotRequired[float]",
        "removed": "bool",
    },
)

CancelAttemptResponse = TypedDict(
    "CancelAttemptResponse",
    {
        "cancelled": "list[str]",
    },
)

CanvasesResponseItem = TypedDict(
    "CanvasesResponseItem",
    {
        "id": "str",
        "name": "str",
    },
)

CanvasResponse = TypedDict(
    "CanvasResponse",
    {
        "nodes": "list[PublishedPanelNode]",
    },
)

CaptureBatchRequestItemsItem = TypedDict(
    "CaptureBatchRequestItemsItem",
    {
        "content": "Any",
        "session_id": "NotRequired[str]",
        "key": "str",
    },
)

CaptureBatchRequest = TypedDict(
    "CaptureBatchRequest",
    {
        "items": "list[CaptureBatchRequestItemsItem]",
    },
)

CaptureBatchResponse = TypedDict(
    "CaptureBatchResponse",
    {
        "id": "str",
        "version": "NotRequired[float]",
        "job_id": "NotRequired[str]",
        "seq": "NotRequired[float]",
        "generation": "NotRequired[float]",
        "receipts": "list[MemoryReceipt]",
    },
)

CaptureRequest = TypedDict(
    "CaptureRequest",
    {
        "content": "Any",
        "session_id": "NotRequired[str]",
    },
)

CatalogPanelSource = TypedDict(
    "CatalogPanelSource",
    {
        "kind": "Literal['resource']",
        "resource": "str",
        "params": "NotRequired[dict[str, str]]",
        "query": "NotRequired[dict[str, Union[str, float, bool]]]",
    },
)

ChannelsResponseChannelsItem = TypedDict(
    "ChannelsResponseChannelsItem",
    {
        "id": "str",
        "name": "str",
    },
)

ChannelsResponse = TypedDict(
    "ChannelsResponse",
    {
        "channels": "list[ChannelsResponseChannelsItem]",
    },
)

CommitTransferRequest = TypedDict(
    "CommitTransferRequest",
    {
        "sha256": "str",
    },
)

CommitTransferResponse = TypedDict(
    "CommitTransferResponse",
    {
        "id": "str",
        "version": "NotRequired[float]",
        "job_id": "NotRequired[str]",
        "seq": "NotRequired[float]",
        "generation": "NotRequired[float]",
        "portable_ids_preserved": "bool",
    },
)

ContextRequest = TypedDict(
    "ContextRequest",
    {
        "include_stale": "NotRequired[bool]",
        "subject": "NotRequired[str]",
        "type": "NotRequired[str]",
        "tier": "NotRequired[str]",
        "query": "str",
        "expansion": "NotRequired[MemoryQueryExpansion]",
        "limit": "NotRequired[float]",
        "mode": "NotRequired[Literal['lexical', 'hybrid']]",
        "allow_degraded": "NotRequired[bool]",
        "valid_at": "NotRequired[float]",
        "include_ended": "NotRequired[bool]",
        "budget_tokens": "NotRequired[float]",
    },
)

ContextResponseCitationsItem = TypedDict(
    "ContextResponseCitationsItem",
    {
        "id": "str",
        "version": "float",
        "source_ids": "list[str]",
        "truncated": "bool",
    },
)

ContextResponse = TypedDict(
    "ContextResponse",
    {
        "text": "str",
        "citations": "list[ContextResponseCitationsItem]",
        "estimated_tokens": "float",
        "generation": "float",
        "degraded": "list[str]",
    },
)

ControlRequest = TypedDict(
    "ControlRequest",
    {
        "targetId": "str",
        "clientMessageId": "str",
        "control": "RuntimeControl",
    },
)

CreateCanvasRequest = TypedDict(
    "CreateCanvasRequest",
    {
        "name": "str",
        "description": "NotRequired[str]",
    },
)

CreateCanvasResponse = TypedDict(
    "CreateCanvasResponse",
    {
        "id": "str",
        "name": "str",
    },
)

CreateSpaceRequest = TypedDict(
    "CreateSpaceRequest",
    {
        "name": "str",
    },
)

DeliveriesResponse = TypedDict(
    "DeliveriesResponse",
    {
        "messages": "list[RoutingMessage]",
    },
)

EraseInvestigationResponse = TypedDict(
    "EraseInvestigationResponse",
    {
        "erased": "bool",
    },
)

FederatedReadResponseOrigin = TypedDict(
    "FederatedReadResponseOrigin",
    {
        "mount": "str",
        "space_id": "str",
        "id": "str",
    },
)

FederatedReadResponse = TypedDict(
    "FederatedReadResponse",
    {
        "origin": "FederatedReadResponseOrigin",
        "result": "Union[MemoryRecord, MemorySourceRange]",
    },
)

FederatedRetrieveRequest = TypedDict(
    "FederatedRetrieveRequest",
    {
        "mounts": "list[str]",
        "retrieval": "MemoryRetrievalInput",
        "allow_partial": "NotRequired[bool]",
    },
)

FederationMountsResponse = TypedDict(
    "FederationMountsResponse",
    {
        "mounts": "list[str]",
    },
)

ForgetMemoryInput = TypedDict(
    "ForgetMemoryInput",
    {
        "record_ids": "NotRequired[list[str]]",
        "source_ids": "NotRequired[list[str]]",
        "all": "NotRequired[bool]",
        "expected_generation": "NotRequired[float]",
    },
)

GrantInvestigationRequest = TypedDict(
    "GrantInvestigationRequest",
    {
        "name": "str",
        "access": "Optional[InvestigationAccess]",
    },
)

GrantInvestigationResponse = TypedDict(
    "GrantInvestigationResponse",
    {
        "name": "str",
        "access": "Optional[InvestigationAccess]",
    },
)

GrantRequest = TypedDict(
    "GrantRequest",
    {
        "principal_id": "str",
        "role": "Optional[Literal['reader', 'writer']]",
    },
)

ImportBundleResponse = TypedDict(
    "ImportBundleResponse",
    {
        "id": "str",
        "version": "NotRequired[float]",
        "job_id": "NotRequired[str]",
        "seq": "NotRequired[float]",
        "generation": "NotRequired[float]",
        "portable_ids_preserved": "bool",
    },
)

InboxResponse = TypedDict(
    "InboxResponse",
    {
        "messages": "list[RoutingMessage]",
    },
)

InteractPanelResponseReceipt = TypedDict(
    "InteractPanelResponseReceipt",
    {
        "id": "str",
        "status": "str",
    },
)

InteractPanelResponse = TypedDict(
    "InteractPanelResponse",
    {
        "status": "str",
        "message": "NotRequired[str]",
        "receipt": "NotRequired[InteractPanelResponseReceipt]",
    },
)

InvestigationActor = TypedDict(
    "InvestigationActor",
    {
        "key": "str",
        "name": "str",
    },
)

# Mutable settlement, separate from the immutable answer (including after cancellation).
InvestigationAttemptAccounting = TypedDict(
    "InvestigationAttemptAccounting",
    {
        "knownUsd": "float",
        "complete": "bool",
        "outstanding": "float",
        "reasons": "NotRequired[list[str]]",
        "pricedCalls": "NotRequired[float]",
        "unknownCalls": "NotRequired[float]",
        "reportedUsd": "NotRequired[float]",
    },
)

InvestigationAttempt = TypedDict(
    "InvestigationAttempt",
    {
        "id": "str",
        "caseId": "str",
        "actor": "InvestigationActor",
        "parentAttemptId": "NotRequired[str]",
        "rootAttemptId": "str",
        "request": "InvestigationRequest",
        "state": "InvestigationState",
        "generation": "NotRequired[str]",
        "sequence": "float",
        "createdAt": "float",
        "updatedAt": "float",
        "accounting": "InvestigationAttemptAccounting",
        "result": "NotRequired[InvestigationResult]",
        "error": "NotRequired[str]",
    },
)

InvestigationCase = TypedDict(
    "InvestigationCase",
    {
        "schema": "Literal['marina.investigation.v1']",
        "id": "str",
        "instanceId": "str",
        "owner": "InvestigationActor",
        "kind": "InvestigationKind",
        "question": "str",
        "selectedAttemptId": "str",
        "currentAttemptId": "NotRequired[str]",
        "createdAt": "float",
        "updatedAt": "float",
        "access": "Union[Literal['owner'], InvestigationAccess]",
    },
)

InvestigationContent = TypedDict(
    "InvestigationContent",
    {
        "id": "str",
        "attemptId": "str",
        "label": "str",
        "value": "Any",
        "bytes": "float",
        "hash": "str",
        "createdAt": "float",
    },
)

InvestigationEvent = TypedDict(
    "InvestigationEvent",
    {
        "attemptId": "str",
        "sequence": "float",
        "at": "float",
        "kind": "str",
        "actor": "str",
        "stageId": "NotRequired[str]",
        "inputId": "NotRequired[str]",
        "outputId": "NotRequired[str]",
        "message": "NotRequired[str]",
    },
)

InvestigationEventPage = TypedDict(
    "InvestigationEventPage",
    {
        "events": "list[InvestigationEvent]",
        "cursor": "float",
        "more": "bool",
        "reset": "bool",
    },
)

InvestigationReason = TypedDict(
    "InvestigationReason",
    {
        "actor": "str",
        "text": "str",
        "sourceIds": "list[str]",
    },
)

InvestigationRequestLimits = TypedDict(
    "InvestigationRequestLimits",
    {
        "calls": "NotRequired[float]",
        "concurrency": "NotRequired[float]",
        "timeoutMs": "NotRequired[float]",
    },
)

InvestigationRequest = TypedDict(
    "InvestigationRequest",
    {
        "kind": "InvestigationKind",
        "question": "str",
        "answer": "NotRequired[PredictionShape]",
        "context": "NotRequired[str]",
        "horizon": "NotRequired[str]",
        "asOf": "NotRequired[str]",
        "caseId": "NotRequired[str]",
        "parentAttemptId": "NotRequired[str]",
        "runs": "NotRequired[float]",
        "limits": "NotRequired[InvestigationRequestLimits]",
    },
)

InvestigationResultCapture = TypedDict(
    "InvestigationResultCapture",
    {
        "status": "Literal['complete', 'partial']",
        "gaps": "list[str]",
    },
)

InvestigationResultAccounting = TypedDict(
    "InvestigationResultAccounting",
    {
        "knownUsd": "float",
        "complete": "bool",
        "outstanding": "float",
        "reasons": "NotRequired[list[str]]",
        "pricedCalls": "NotRequired[float]",
        "unknownCalls": "NotRequired[float]",
        "reportedUsd": "NotRequired[float]",
    },
)

InvestigationResult = TypedDict(
    "InvestigationResult",
    {
        "schema": "Literal['marina.investigation.v1']",
        "kind": "InvestigationKind",
        "summary": "str",
        "availability": "Literal['final', 'partial', 'none']",
        "estimate": "NotRequired[PredictionEstimate]",
        "report": "NotRequired[str]",
        "reasons": "list[InvestigationReason]",
        "sources": "list[InvestigationSource]",
        "limitations": "list[str]",
        "horizon": "NotRequired[str]",
        "cutoff": "NotRequired[str]",
        "answerId": "NotRequired[float]",
        "outputId": "NotRequired[str]",
        "capture": "InvestigationResultCapture",
        "accounting": "InvestigationResultAccounting",
    },
)

InvestigationSnapshotAttemptsItem = TypedDict(
    "InvestigationSnapshotAttemptsItem",
    {
        "id": "str",
        "actor": "InvestigationActor",
        "state": "InvestigationState",
        "createdAt": "float",
    },
)

InvestigationSnapshotChildrenItem = TypedDict(
    "InvestigationSnapshotChildrenItem",
    {
        "caseId": "str",
        "attemptId": "str",
        "question": "str",
        "state": "InvestigationState",
    },
)

InvestigationSnapshotResolution = TypedDict(
    "InvestigationSnapshotResolution",
    {
        "at": "float",
        "value": "Any",
        "loss": "Optional[float]",
    },
)

InvestigationSnapshotGrantsItem = TypedDict(
    "InvestigationSnapshotGrantsItem",
    {
        "name": "str",
        "access": "InvestigationAccess",
    },
)

InvestigationSnapshot = TypedDict(
    "InvestigationSnapshot",
    {
        "case": "InvestigationCase",
        "attempt": "InvestigationAttempt",
        "attempts": "list[InvestigationSnapshotAttemptsItem]",
        "cursor": "float",
        "children": "list[InvestigationSnapshotChildrenItem]",
        "resolution": "NotRequired[InvestigationSnapshotResolution]",
        "grants": "NotRequired[list[InvestigationSnapshotGrantsItem]]",
    },
)

InvestigationSource = TypedDict(
    "InvestigationSource",
    {
        "id": "str",
        "url": "str",
        "title": "NotRequired[str]",
    },
)

JsonStoreRequestOperationsItem1 = TypedDict(
    "JsonStoreRequestOperationsItem1",
    {
        "namespace": "list[str]",
        "key": "str",
        "value": "NotRequired[Optional[dict[str, Any]]]",
        "index": "NotRequired[Any]",
    },
)

JsonStoreRequestOperationsItem2 = TypedDict(
    "JsonStoreRequestOperationsItem2",
    {
        "namespacePrefix": "list[str]",
        "filter": "NotRequired[dict[str, Any]]",
        "query": "NotRequired[str]",
        "limit": "NotRequired[float]",
        "offset": "NotRequired[float]",
    },
)

JsonStoreRequestOperationsItem3 = TypedDict(
    "JsonStoreRequestOperationsItem3",
    {
        "matchConditions": "NotRequired[list[Any]]",
        "maxDepth": "NotRequired[float]",
        "limit": "NotRequired[float]",
        "offset": "NotRequired[float]",
    },
)

JsonStoreRequest = TypedDict(
    "JsonStoreRequest",
    {
        "operations": "list[Union[JsonStoreRequestOperationsItem1, JsonStoreRequestOperationsItem2, JsonStoreRequestOperationsItem3]]",
    },
)

JsonStoreResponse = TypedDict(
    "JsonStoreResponse",
    {
        "results": "list[Any]",
    },
)

KnowledgeGraphRequest = TypedDict(
    "KnowledgeGraphRequest",
    {
        "action": "MemoryGraphAction",
    },
)

ListInvestigationsResponse = TypedDict(
    "ListInvestigationsResponse",
    {
        "cases": "list[InvestigationCase]",
    },
)

MaterializeRuleRequest = TypedDict(
    "MaterializeRuleRequest",
    {
        "id": "str",
        "expected_version": "float",
        "valid_at": "NotRequired[float]",
    },
)

MaterializeRuleResponse = TypedDict(
    "MaterializeRuleResponse",
    {
        "id": "str",
        "version": "NotRequired[float]",
        "job_id": "NotRequired[str]",
        "seq": "NotRequired[float]",
        "generation": "NotRequired[float]",
        "records": "list[MemoryReceipt]",
    },
)

MemoryAdoptInput = TypedDict(
    "MemoryAdoptInput",
    {
        "job_id": "str",
        "target_space_id": "NotRequired[str]",
        "rationale": "NotRequired[str]",
        "valid_time": "NotRequired[Optional[MemoryValidity]]",
        "confirm_abstention": "NotRequired[bool]",
    },
)

MemoryAdoptResult = TypedDict(
    "MemoryAdoptResult",
    {
        "id": "str",
        "version": "NotRequired[float]",
        "job_id": "str",
        "seq": "NotRequired[float]",
        "generation": "NotRequired[float]",
        "space_id": "str",
        "state": "Literal['adopted', 'abstention_confirmed']",
        "existing": "bool",
        "ratified_by": "Optional[MemoryRatifiedBy]",
        "credited": "list[MemoryStandingCredit]",
    },
)

MemoryAnswerAnswered = TypedDict(
    "MemoryAnswerAnswered",
    {
        "status": "Literal['answered']",
        "answer": "Any",
        "citations": "list[MemoryCitation]",
    },
)

MemoryAnswerAbstained = TypedDict(
    "MemoryAnswerAbstained",
    {
        "status": "Literal['abstained']",
        "reason": "str",
    },
)

# Assistance is explicitly delegated reading and a cited proposal, never a
# grant to edit the requester's memories or to certify a claim as true.
MemoryAssistanceInput = TypedDict(
    "MemoryAssistanceInput",
    {
        "worker_id": "str",
        "role": "MemoryHelperRole",
        "task": "str",
        "max_operations": "NotRequired[float]",
        "timeout_ms": "NotRequired[float]",
    },
)

MemoryAssistanceJob = TypedDict(
    "MemoryAssistanceJob",
    {
        "id": "str",
        "space_id": "str",
        "requester_id": "str",
        "worker_id": "str",
        "role": "MemoryHelperRole",
        "parent_id": "Optional[str]",
        "root_id": "str",
        "depth": "float",
        "state": "Literal['pending', 'running', 'answered', 'abstained', 'cancelled', 'expired']",
        "work_open": "bool",
        "version": "float",
        "lease_until": "Optional[float]",
        "deadline": "float",
        "remaining_operations": "float",
        "input_source_id": "str",
        "result_record_id": "Optional[str]",
        "created_at": "float",
        "task": "NotRequired[str]",
        "result": "NotRequired[MemoryAnswer]",
    },
)

MemoryAssistancePage = TypedDict(
    "MemoryAssistancePage",
    {
        "jobs": "list[MemoryAssistanceJob]",
        "next_cursor": "Optional[str]",
    },
)

MemoryBinding2 = TypedDict(
    "MemoryBinding2",
    {
        "kind": "Literal['symbol']",
        "value": "str",
    },
)

MemoryBundlePayloadSourcesItem = TypedDict(
    "MemoryBundlePayloadSourcesItem",
    {
        "id": "str",
        "space_id": "str",
        "seq": "float",
        "session_id": "Optional[str]",
        "body": "Any",
        "content_hash": "str",
        "created_at": "float",
        "body_sha256": "str",
    },
)

MemoryBundlePayloadRecordsItemVersionsItem = TypedDict(
    "MemoryBundlePayloadRecordsItemVersionsItem",
    {
        "record": "MemoryRecord",
        "attributes": "Optional[dict[str, Any]]",
    },
)

MemoryBundlePayloadRecordsItem = TypedDict(
    "MemoryBundlePayloadRecordsItem",
    {
        "id": "str",
        "version": "float",
        "created_at": "float",
        "stale": "float",
        "stale_reason": "Optional[str]",
        "versions": "list[MemoryBundlePayloadRecordsItemVersionsItem]",
    },
)

MemoryBundlePayloadVocabulariesItem = TypedDict(
    "MemoryBundlePayloadVocabulariesItem",
    {
        "version": "float",
        "definition": "str",
        "created_at": "float",
    },
)

MemoryBundlePayloadCheckpointsItem = TypedDict(
    "MemoryBundlePayloadCheckpointsItem",
    {
        "name": "str",
        "version": "float",
        "source_cursor": "float",
        "data": "str",
        "updated_at": "float",
    },
)

MemoryBundlePayload = TypedDict(
    "MemoryBundlePayload",
    {
        "origin_space": "str",
        "sources": "list[MemoryBundlePayloadSourcesItem]",
        "records": "list[MemoryBundlePayloadRecordsItem]",
        "vocabularies": "list[MemoryBundlePayloadVocabulariesItem]",
        "checkpoints": "list[MemoryBundlePayloadCheckpointsItem]",
    },
)

# Portable history envelope. Authorization and indexes are deliberately excluded.
MemoryBundle = TypedDict(
    "MemoryBundle",
    {
        "schema": "Literal['marina.memory.bundle.v2']",
        "sha256": "str",
        "payload": "MemoryBundlePayload",
        "excluded": "list[str]",
    },
)

MemoryCachedRetrievalInputRetrievalRequirementsItemClaim = TypedDict(
    "MemoryCachedRetrievalInputRetrievalRequirementsItemClaim",
    {
        "kind": "Literal['claim']",
        "subject": "str",
        "predicate": "str",
    },
)

MemoryCachedRetrievalInputRetrievalRequirementsItemSource = TypedDict(
    "MemoryCachedRetrievalInputRetrievalRequirementsItemSource",
    {
        "kind": "Literal['source']",
        "id": "str",
        "start": "NotRequired[float]",
        "end": "NotRequired[float]",
    },
)

MemoryCachedRetrievalInputRetrieval = TypedDict(
    "MemoryCachedRetrievalInputRetrieval",
    {
        "task": "str",
        "selection": "NotRequired[MemorySelection]",
        "expansion": "NotRequired[MemoryQueryExpansion]",
        "requirements": "NotRequired[list[Union[MemoryCachedRetrievalInputRetrievalRequirementsItemClaim, MemoryCachedRetrievalInputRetrievalRequirementsItemSource]]]",
        "observe": "NotRequired[bool]",
        "steps": "NotRequired[list[MemoryPlanStep]]",
        "use_model": "NotRequired[bool]",
        "broaden": "NotRequired[bool]",
        "valid_at": "float",
        "max_results": "NotRequired[float]",
        "max_bytes": "NotRequired[float]",
        "source_bytes": "NotRequired[float]",
    },
)

MemoryCachedRetrievalInput = TypedDict(
    "MemoryCachedRetrievalInput",
    {
        "retrieval": "MemoryCachedRetrievalInputRetrieval",
        "mounts": "NotRequired[list[str]]",
        "allow_partial": "NotRequired[bool]",
        "cache": "NotRequired[Literal['read', 'read_write', 'refresh']]",
        "ttl_ms": "NotRequired[float]",
    },
)

MemoryCachedRetrievalResultCache = TypedDict(
    "MemoryCachedRetrievalResultCache",
    {
        "hit": "bool",
        "reason": "str",
        "stored": "NotRequired[bool]",
    },
)

MemoryCachedRetrievalResult = TypedDict(
    "MemoryCachedRetrievalResult",
    {
        "retrieval": "Union[MemoryRetrievalResult, MemoryFederatedRetrievalResult]",
        "cache": "MemoryCachedRetrievalResultCache",
    },
)

MemoryCacheInput = TypedDict(
    "MemoryCacheInput",
    {
        "inputs": "Any",
        "model": "str",
        "policy": "str",
    },
)

MemoryCacheResult1 = TypedDict(
    "MemoryCacheResult1",
    {
        "hit": "Literal[False]",
        "reason": "str",
    },
)

MemoryCacheResult2RecordsItem = TypedDict(
    "MemoryCacheResult2RecordsItem",
    {
        "id": "str",
        "version": "float",
    },
)

MemoryCacheResult2SourcesItem = TypedDict(
    "MemoryCacheResult2SourcesItem",
    {
        "id": "str",
        "content_hash": "str",
    },
)

MemoryCacheResult2 = TypedDict(
    "MemoryCacheResult2",
    {
        "hit": "Literal[True]",
        "value": "Any",
        "records": "list[MemoryCacheResult2RecordsItem]",
        "sources": "list[MemoryCacheResult2SourcesItem]",
        "federated": "NotRequired[list[MemoryFederatedPin]]",
        "expires_at": "float",
    },
)

MemoryCacheWriteRecordsItem = TypedDict(
    "MemoryCacheWriteRecordsItem",
    {
        "id": "str",
        "version": "float",
    },
)

MemoryCacheWriteSourcesItem = TypedDict(
    "MemoryCacheWriteSourcesItem",
    {
        "id": "str",
        "content_hash": "str",
    },
)

MemoryCacheWrite = TypedDict(
    "MemoryCacheWrite",
    {
        "inputs": "Any",
        "model": "str",
        "policy": "str",
        "value": "Any",
        "records": "NotRequired[list[MemoryCacheWriteRecordsItem]]",
        "sources": "NotRequired[list[MemoryCacheWriteSourcesItem]]",
        "federated": "NotRequired[list[MemoryFederatedPin]]",
        "expires_at": "float",
    },
)

MemoryCheckpoint = TypedDict(
    "MemoryCheckpoint",
    {
        "name": "str",
        "version": "float",
        "source_cursor": "float",
        "data": "dict[str, Any]",
        "updated_at": "float",
    },
)

MemoryCheckpointCaptureItemsItem = TypedDict(
    "MemoryCheckpointCaptureItemsItem",
    {
        "content": "Any",
        "key": "str",
    },
)

# The server adds `source_ids` (resolved `order`) to this content.
MemoryCheckpointCaptureManifest = TypedDict(
    "MemoryCheckpointCaptureManifest",
    {
        "key": "str",
        "content": "dict[str, Any]",
    },
)

# Input of an atomic checkpoint capture (`capture_checkpoint`).
MemoryCheckpointCapture = TypedDict(
    "MemoryCheckpointCapture",
    {
        "expected_version": "float",
        "session_id": "NotRequired[str]",
        "items": "NotRequired[list[MemoryCheckpointCaptureItemsItem]]",
        "order": "list[Union[str, float]]",
        "manifest": "MemoryCheckpointCaptureManifest",
        "field": "str",
        "entry": "dict[str, Any]",
        "data": "dict[str, Any]",
        "source_ids": "NotRequired[list[str]]",
        "cursor": "NotRequired[Union[Literal['manifest'], float]]",
        "checkpoint_key": "str",
    },
)

MemoryCheckpointCaptureReceiptManifest = TypedDict(
    "MemoryCheckpointCaptureReceiptManifest",
    {
        "id": "str",
        "seq": "float",
    },
)

MemoryCheckpointCaptureReceipt = TypedDict(
    "MemoryCheckpointCaptureReceipt",
    {
        "id": "str",
        "version": "NotRequired[float]",
        "job_id": "NotRequired[str]",
        "seq": "NotRequired[float]",
        "generation": "NotRequired[float]",
        "manifest": "MemoryCheckpointCaptureReceiptManifest",
        "source_ids": "list[str]",
    },
)

MemoryCitationRecord = TypedDict(
    "MemoryCitationRecord",
    {
        "kind": "Literal['record']",
        "space_id": "str",
        "id": "str",
        "version": "float",
        "quote": "str",
    },
)

MemoryCitationSource = TypedDict(
    "MemoryCitationSource",
    {
        "kind": "Literal['source']",
        "space_id": "str",
        "id": "str",
        "text_hash": "str",
        "start": "float",
        "end": "float",
        "quote": "str",
    },
)

MemoryClaim = TypedDict(
    "MemoryClaim",
    {
        "subject": "str",
        "predicate": "str",
        "object": "MemoryTerm",
    },
)

MemoryErrorError = TypedDict(
    "MemoryErrorError",
    {
        "code": "str",
        "message": "str",
        "retry_after_ms": "NotRequired[float]",
    },
)

# Every memory API failure.
MemoryError = TypedDict(
    "MemoryError",
    {
        "error": "MemoryErrorError",
    },
)

MemoryExpansionCoverage = TypedDict(
    "MemoryExpansionCoverage",
    {
        "policy": "str",
        "queries": "list[str]",
        "candidates": "list[float]",
        "candidate_limit": "float",
        "fusion": "Literal['mean-alternatives-rrf:k=60']",
    },
)

MemoryFederatedRead = TypedDict(
    "MemoryFederatedRead",
    {
        "mount": "str",
        "id": "str",
        "kind": "Literal['record', 'source']",
        "version": "NotRequired[float]",
        "start": "NotRequired[float]",
        "end": "NotRequired[float]",
    },
)

MemoryFederatedResultFailuresItem = TypedDict(
    "MemoryFederatedResultFailuresItem",
    {
        "mount": "str",
        "code": "str",
    },
)

MemoryFederatedResult = TypedDict(
    "MemoryFederatedResult",
    {
        "results": "list[MemoryFederatedEntry]",
        "failures": "list[MemoryFederatedResultFailuresItem]",
        "incomplete": "bool",
        "bytes": "float",
        "truncated": "bool",
        "consistency": "Literal['per-peer-read-snapshots']",
        "replicated": "Literal[False]",
    },
)

MemoryFederatedRetrievalResultPeersItem = TypedDict(
    "MemoryFederatedRetrievalResultPeersItem",
    {
        "mount": "str",
        "space_id": "NotRequired[str]",
        "status": "Literal['ok', 'truncated', 'unavailable', 'budget_exhausted']",
        "retrieval_generation": "NotRequired[float]",
        "vocabulary_version": "NotRequired[float]",
        "valid_at": "NotRequired[float]",
        "code": "NotRequired[str]",
    },
)

MemoryFederatedRetrievalResult = TypedDict(
    "MemoryFederatedRetrievalResult",
    {
        "schema": "Literal['marina.memory.federated-retrieval.v1']",
        "evidence": "list[dict[str, Any]]",
        "peers": "list[MemoryFederatedRetrievalResultPeersItem]",
        "bytes": "float",
        "consistency": "Literal['per-peer']",
        "answer_sufficiency": "Literal['not_assessed']",
        "truncated": "bool",
    },
)

MemoryFederatedSearch = TypedDict(
    "MemoryFederatedSearch",
    {
        "mounts": "list[str]",
        "query": "str",
        "kind": "NotRequired[Literal['records', 'sources']]",
        "mode": "NotRequired[Literal['lexical', 'hybrid']]",
        "limit": "NotRequired[float]",
        "max_bytes": "NotRequired[float]",
        "allow_partial": "NotRequired[bool]",
    },
)

MemoryGraphQuery = TypedDict(
    "MemoryGraphQuery",
    {
        "include_stale": "NotRequired[bool]",
        "valid_at": "NotRequired[float]",
        "subject": "str",
        "predicates": "NotRequired[list[str]]",
        "direction": "NotRequired[Literal['out', 'in', 'both']]",
        "max_depth": "NotRequired[float]",
        "limit": "NotRequired[float]",
    },
)

MemoryGraphResultEdgesItem = TypedDict(
    "MemoryGraphResultEdgesItem",
    {
        "record": "MemoryRecord",
        "path": "list[str]",
    },
)

MemoryGraphResult = TypedDict(
    "MemoryGraphResult",
    {
        "space_id": "str",
        "generation": "float",
        "root": "str",
        "edges": "list[MemoryGraphResultEdgesItem]",
        "truncated": "bool",
    },
)

MemoryJobStatus = TypedDict(
    "MemoryJobStatus",
    {
        "id": "str",
        "space_id": "str",
        "record_id": "str",
        "note_id": "float",
        "model": "str",
        "state": "str",
        "attempts": "float",
        "lease_until": "Optional[float]",
        "error": "Optional[str]",
        "created_at": "float",
    },
)

MemoryJoin = TypedDict(
    "MemoryJoin",
    {
        "patterns": "list[MemoryPattern]",
        "select": "NotRequired[list[str]]",
        "valid_at": "NotRequired[float]",
        "limit": "NotRequired[float]",
    },
)

MemoryJoinResultTraceItem = TypedDict(
    "MemoryJoinResultTraceItem",
    {
        "pattern": "float",
        "candidates": "float",
        "matches": "float",
    },
)

MemoryJoinResult = TypedDict(
    "MemoryJoinResult",
    {
        "space_id": "str",
        "generation": "float",
        "results": "list[MemoryMatch]",
        "truncated": "bool",
        "trace": "list[MemoryJoinResultTraceItem]",
        "semantics": "Literal['asserted-nonrecursive']",
    },
)

MemoryMatchWitnessesItem = TypedDict(
    "MemoryMatchWitnessesItem",
    {
        "id": "str",
        "version": "float",
    },
)

MemoryMatch = TypedDict(
    "MemoryMatch",
    {
        "bindings": "dict[str, MemoryBinding]",
        "witnesses": "list[MemoryMatchWitnessesItem]",
        "valid_time": "MemoryValidity",
    },
)

MemoryPattern = TypedDict(
    "MemoryPattern",
    {
        "subject": "Union[str, MemoryVariable]",
        "predicate": "Union[str, MemoryVariable]",
        "object": "Union[MemoryTerm, MemoryVariable]",
    },
)

MemoryPlanBudget = TypedDict(
    "MemoryPlanBudget",
    {
        "max_results": "float",
        "max_bytes": "float",
    },
)

MemoryPlan = TypedDict(
    "MemoryPlan",
    {
        "retrieval_generation": "NotRequired[float]",
        "schema": "Literal['marina.memory.plan.v1']",
        "space_id": "str",
        "generation": "float",
        "vocabulary_version": "float",
        "task": "str",
        "planner": "str",
        "assumptions": "list[str]",
        "steps": "list[MemoryPlanStep]",
        "budget": "MemoryPlanBudget",
    },
)

MemoryPlanResultTraceItem = TypedDict(
    "MemoryPlanResultTraceItem",
    {
        "operation": "Literal['query', 'graph', 'search', 'source_search', 'join']",
        "input": "dict[str, Any]",
        "evidence": "list[Any]",
        "truncated": "bool",
    },
)

MemoryPlanResult = TypedDict(
    "MemoryPlanResult",
    {
        "space_id": "str",
        "generation": "float",
        "trace": "list[MemoryPlanResultTraceItem]",
        "bytes": "float",
        "truncated": "bool",
        "answer_sufficiency": "Literal['not_assessed']",
    },
)

MemoryPlanStep = TypedDict(
    "MemoryPlanStep",
    {
        "operation": "Literal['query', 'graph', 'search', 'source_search', 'join']",
        "input": "dict[str, Any]",
    },
)

MemoryQuery = TypedDict(
    "MemoryQuery",
    {
        "include_stale": "NotRequired[bool]",
        "valid_at": "NotRequired[float]",
        "subject": "NotRequired[str]",
        "predicate": "NotRequired[str]",
        "object": "NotRequired[MemoryTerm]",
        "type": "NotRequired[str]",
        "tier": "NotRequired[str]",
        "limit": "NotRequired[float]",
        "cursor": "NotRequired[str]",
    },
)

# Caller-selected alternatives are retrieval hints, never new assertions.
MemoryQueryExpansion = TypedDict(
    "MemoryQueryExpansion",
    {
        "policy": "str",
        "queries": "list[str]",
    },
)

MemoryQueryResult = TypedDict(
    "MemoryQueryResult",
    {
        "space_id": "str",
        "generation": "float",
        "mode": "Literal['symbolic']",
        "results": "list[MemoryRecord]",
        "next_cursor": "Optional[str]",
    },
)

# Why a record lives in a shared (institutional) space. Stamped by `adopt`
# and `pool <name> ratify`; every institutional record answers "why is this
# shared?" from its own metadata.
MemoryRatifiedBy = TypedDict(
    "MemoryRatifiedBy",
    {
        "principal_id": "str",
        "name": "str",
        "standing": "float",
        "at": "float",
        "rationale": "Optional[str]",
        "basis": "Literal['standing', 'sovereign', 'local-ungated']",
    },
)

MemoryReceipt = TypedDict(
    "MemoryReceipt",
    {
        "id": "str",
        "version": "NotRequired[float]",
        "job_id": "NotRequired[str]",
        "seq": "NotRequired[float]",
        "generation": "NotRequired[float]",
    },
)

MemoryRecordStaleReason = TypedDict(
    "MemoryRecordStaleReason",
    {
        "kind": "str",
        "record_id": "NotRequired[str]",
        "observed_version": "NotRequired[float]",
    },
)

MemoryRecord = TypedDict(
    "MemoryRecord",
    {
        "freshness": "NotRequired[Literal['current', 'stale', 'historical']]",
        "stale_reason": "NotRequired[Optional[MemoryRecordStaleReason]]",
        "dependency_versions": "NotRequired[dict[str, Optional[float]]]",
        "valid_time": "NotRequired[Optional[MemoryValidity]]",
        "vocabulary_version": "NotRequired[float]",
        "id": "str",
        "space_id": "str",
        "version": "float",
        "content": "str",
        "type": "str",
        "tier": "str",
        "importance": "float",
        "subject": "Optional[str]",
        "metadata": "dict[str, Any]",
        "source_ids": "list[str]",
        "depends_on": "list[str]",
        "created_at": "float",
        "claim": "NotRequired[Optional[MemoryClaim]]",
    },
)

MemoryRecordInput = TypedDict(
    "MemoryRecordInput",
    {
        "dependency_versions": "NotRequired[dict[str, float]]",
        "valid_time": "NotRequired[Optional[MemoryValidity]]",
        "expected_vocabulary_version": "NotRequired[float]",
        "content": "str",
        "type": "NotRequired[Literal['fact', 'observation', 'decision', 'inference', 'skill', 'episode']]",
        "tier": "NotRequired[Literal['fact', 'reflection', 'skill']]",
        "importance": "NotRequired[float]",
        "subject": "NotRequired[str]",
        "metadata": "NotRequired[dict[str, Any]]",
        "source_ids": "NotRequired[list[str]]",
        "depends_on": "NotRequired[list[str]]",
        "claim": "NotRequired[Optional[MemoryClaim]]",
    },
)

MemoryReputationRankingAuthorsValue = TypedDict(
    "MemoryReputationRankingAuthorsValue",
    {
        "author": "Optional[str]",
        "standing": "float",
        "term": "float",
    },
)

MemoryReputationRankingUsefulnessItemsValue = TypedDict(
    "MemoryReputationRankingUsefulnessItemsValue",
    {
        "alpha": "float",
        "beta": "float",
        "n": "float",
        "mean": "float",
        "term": "float",
    },
)

# Usefulness factor from others' evidence (`MARINA_MEMORY_USEFULNESS_RANKING`); absent when off.
MemoryReputationRankingUsefulness = TypedDict(
    "MemoryReputationRankingUsefulness",
    {
        "mode": "Literal['observe', 'on']",
        "weight": "float",
        "applied": "bool",
        "items": "dict[str, MemoryReputationRankingUsefulnessItemsValue]",
    },
)

# Reputation-weighted re-rank applied to SHARED-space search results (records the
#  actor does not own). Bounded, inspectable, deterministic — see db-memory-ranking.ts.
MemoryReputationRanking = TypedDict(
    "MemoryReputationRanking",
    {
        "weight": "float",
        "standing_ceiling": "float",
        "applied": "float",
        "considered": "float",
        "authors": "dict[str, MemoryReputationRankingAuthorsValue]",
        "usefulness": "NotRequired[MemoryReputationRankingUsefulness]",
    },
)

MemoryResolutionMembership = TypedDict(
    "MemoryResolutionMembership",
    {
        "id": "str",
        "policy": "MemoryResolvePolicy",
        "status": "MemoryResolutionStatus",
        "role": "MemoryResolutionRole",
        "rationale": "str",
        "deadline": "Optional[float]",
        "created_at": "float",
    },
)

MemoryResolveResultSupersededItem = TypedDict(
    "MemoryResolveResultSupersededItem",
    {
        "id": "str",
        "version": "float",
        "valid_time": "Optional[MemoryValidity]",
    },
)

MemoryResolveResult = TypedDict(
    "MemoryResolveResult",
    {
        "id": "str",
        "version": "NotRequired[float]",
        "job_id": "NotRequired[str]",
        "seq": "NotRequired[float]",
        "generation": "NotRequired[float]",
        "record_id": "str",
        "policy": "MemoryResolvePolicy",
        "status": "MemoryResolutionStatus",
        "winner": "Optional[str]",
        "superseded": "list[MemoryResolveResultSupersededItem]",
        "peers": "list[str]",
        "pending": "list[str]",
        "evidence_counts": "Optional[dict[str, float]]",
        "deadline": "Optional[float]",
    },
)

MemoryRetrievalInputRequirementsItemClaim = TypedDict(
    "MemoryRetrievalInputRequirementsItemClaim",
    {
        "kind": "Literal['claim']",
        "subject": "str",
        "predicate": "str",
    },
)

MemoryRetrievalInputRequirementsItemSource = TypedDict(
    "MemoryRetrievalInputRequirementsItemSource",
    {
        "kind": "Literal['source']",
        "id": "str",
        "start": "NotRequired[float]",
        "end": "NotRequired[float]",
    },
)

# One bounded retrieval, including witnessed original-source reads.
MemoryRetrievalInput = TypedDict(
    "MemoryRetrievalInput",
    {
        "task": "str",
        "selection": "NotRequired[MemorySelection]",
        "expansion": "NotRequired[MemoryQueryExpansion]",
        "requirements": "NotRequired[list[Union[MemoryRetrievalInputRequirementsItemClaim, MemoryRetrievalInputRequirementsItemSource]]]",
        "observe": "NotRequired[bool]",
        "steps": "NotRequired[list[MemoryPlanStep]]",
        "use_model": "NotRequired[bool]",
        "broaden": "NotRequired[bool]",
        "valid_at": "NotRequired[float]",
        "max_results": "NotRequired[float]",
        "max_bytes": "NotRequired[float]",
        "source_bytes": "NotRequired[float]",
    },
)

MemoryRetrievalResultTraceItem = TypedDict(
    "MemoryRetrievalResultTraceItem",
    {
        "operation": "Union[Literal['source_range'], Literal['query', 'graph', 'search', 'source_search', 'join']]",
        "input": "dict[str, Any]",
        "returned": "float",
        "truncated": "bool",
        "reason": "Literal['planned', 'empty_source_search', 'sparse_source_search', 'read_original']",
    },
)

MemoryRetrievalResultBudget = TypedDict(
    "MemoryRetrievalResultBudget",
    {
        "max_results": "float",
        "max_bytes": "float",
        "source_bytes": "float",
    },
)

MemoryRetrievalResultSelectedRecipe = TypedDict(
    "MemoryRetrievalResultSelectedRecipe",
    {
        "space_id": "str",
        "id": "str",
        "version": "float",
    },
)

MemoryRetrievalResultCoverageItemRequirementClaim = TypedDict(
    "MemoryRetrievalResultCoverageItemRequirementClaim",
    {
        "kind": "Literal['claim']",
        "subject": "str",
        "predicate": "str",
    },
)

MemoryRetrievalResultCoverageItemRequirementSource = TypedDict(
    "MemoryRetrievalResultCoverageItemRequirementSource",
    {
        "kind": "Literal['source']",
        "id": "str",
        "start": "NotRequired[float]",
        "end": "NotRequired[float]",
    },
)

MemoryRetrievalResultCoverageItem = TypedDict(
    "MemoryRetrievalResultCoverageItem",
    {
        "requirement": "Union[MemoryRetrievalResultCoverageItemRequirementClaim, MemoryRetrievalResultCoverageItemRequirementSource]",
        "covered": "bool",
    },
)

MemoryRetrievalResultKnownConflictsItem = TypedDict(
    "MemoryRetrievalResultKnownConflictsItem",
    {
        "subject": "str",
        "predicate": "str",
        "records": "list[str]",
    },
)

MemoryRetrievalResultDiagnostics = TypedDict(
    "MemoryRetrievalResultDiagnostics",
    {
        "broadened": "bool",
        "discovery_truncated": "bool",
        "budget_limited": "bool",
        "filtered_records": "float",
        "partial_sources": "float",
        "next_actions": "list[str]",
    },
)

MemoryRetrievalResult = TypedDict(
    "MemoryRetrievalResult",
    {
        "schema": "Literal['marina.memory.retrieval.v1']",
        "space_id": "str",
        "generation": "float",
        "retrieval_generation": "float",
        "vocabulary_version": "float",
        "valid_at": "float",
        "status": "Literal['evidence', 'empty', 'budget_exhausted']",
        "plan": "MemoryPlan",
        "evidence": "list[MemoryRetrievedEvidence]",
        "trace": "list[MemoryRetrievalResultTraceItem]",
        "budget": "MemoryRetrievalResultBudget",
        "bytes": "float",
        "truncated": "bool",
        "answer_sufficiency": "Literal['not_assessed']",
        "selection": "NotRequired[MemorySelection]",
        "selection_contract": "NotRequired[Literal['marina-evidence-selection-v1']]",
        "selected_recipe": "NotRequired[MemoryRetrievalResultSelectedRecipe]",
        "observed_candidates": "NotRequired[list[MemoryRetrievedEvidence]]",
        "coverage": "NotRequired[list[MemoryRetrievalResultCoverageItem]]",
        "known_conflicts": "NotRequired[list[MemoryRetrievalResultKnownConflictsItem]]",
        "diagnostics": "MemoryRetrievalResultDiagnostics",
        "limitations": "list[str]",
    },
)

MemoryRetrievedEvidenceRecordStaleReason = TypedDict(
    "MemoryRetrievedEvidenceRecordStaleReason",
    {
        "kind": "str",
        "record_id": "NotRequired[str]",
        "observed_version": "NotRequired[float]",
    },
)

MemoryRetrievedEvidenceRecord = TypedDict(
    "MemoryRetrievedEvidenceRecord",
    {
        "freshness": "NotRequired[Literal['current', 'stale', 'historical']]",
        "stale_reason": "NotRequired[Optional[MemoryRetrievedEvidenceRecordStaleReason]]",
        "dependency_versions": "NotRequired[dict[str, Optional[float]]]",
        "valid_time": "NotRequired[Optional[MemoryValidity]]",
        "vocabulary_version": "NotRequired[float]",
        "id": "str",
        "space_id": "str",
        "version": "float",
        "content": "str",
        "type": "str",
        "tier": "str",
        "importance": "float",
        "subject": "Optional[str]",
        "metadata": "dict[str, Any]",
        "source_ids": "list[str]",
        "depends_on": "list[str]",
        "created_at": "float",
        "claim": "NotRequired[Optional[MemoryClaim]]",
        "kind": "Literal['record']",
    },
)

MemoryRetrievedEvidenceUtf8SourceTextV1 = TypedDict(
    "MemoryRetrievedEvidenceUtf8SourceTextV1",
    {
        "id": "str",
        "session_id": "Optional[str]",
        "content_hash": "str",
        "text_hash": "str",
        "representation": "Literal['utf8-source-text-v1']",
        "start": "float",
        "end": "float",
        "total_bytes": "float",
        "next_start": "Optional[float]",
        "text": "str",
        "kind": "Literal['source']",
        "space_id": "str",
    },
)

MemoryReviewResultItemsItemPremisesItem = TypedDict(
    "MemoryReviewResultItemsItemPremisesItem",
    {
        "id": "str",
        "pinned_version": "Optional[float]",
        "current_version": "Optional[float]",
        "state": "str",
    },
)

MemoryReviewResultItemsItem = TypedDict(
    "MemoryReviewResultItemsItem",
    {
        "record": "MemoryRecord",
        "premises": "list[MemoryReviewResultItemsItemPremisesItem]",
        "competing_records": "list[MemoryRecord]",
        "competing_truncated": "bool",
        "resolution": "NotRequired[MemoryResolutionMembership]",
    },
)

MemoryReviewResult = TypedDict(
    "MemoryReviewResult",
    {
        "space_id": "str",
        "retrieval_generation": "float",
        "items": "list[MemoryReviewResultItemsItem]",
        "next_cursor": "Optional[str]",
    },
)

MemoryRule = TypedDict(
    "MemoryRule",
    {
        "schema": "Literal['marina.memory.rule.v1']",
        "name": "str",
        "query": "MemoryJoin",
        "conclusion": "MemoryPattern",
    },
)

MemoryRuleResultResultsItemWitnessesItem = TypedDict(
    "MemoryRuleResultResultsItemWitnessesItem",
    {
        "id": "str",
        "version": "float",
    },
)

MemoryRuleResultResultsItem = TypedDict(
    "MemoryRuleResultResultsItem",
    {
        "bindings": "dict[str, MemoryBinding]",
        "witnesses": "list[MemoryRuleResultResultsItemWitnessesItem]",
        "valid_time": "MemoryValidity",
        "claim": "MemoryClaim",
    },
)

MemoryRuleResultTraceItem = TypedDict(
    "MemoryRuleResultTraceItem",
    {
        "pattern": "float",
        "candidates": "float",
        "matches": "float",
    },
)

MemoryRuleResultRule = TypedDict(
    "MemoryRuleResultRule",
    {
        "id": "str",
        "version": "float",
    },
)

MemoryRuleResult = TypedDict(
    "MemoryRuleResult",
    {
        "space_id": "str",
        "generation": "float",
        "results": "list[MemoryRuleResultResultsItem]",
        "truncated": "bool",
        "trace": "list[MemoryRuleResultTraceItem]",
        "semantics": "Literal['asserted-nonrecursive']",
        "rule": "MemoryRuleResultRule",
    },
)

MemorySearchInput = TypedDict(
    "MemorySearchInput",
    {
        "include_stale": "NotRequired[bool]",
        "subject": "NotRequired[str]",
        "type": "NotRequired[str]",
        "tier": "NotRequired[str]",
        "query": "str",
        "expansion": "NotRequired[MemoryQueryExpansion]",
        "limit": "NotRequired[float]",
        "mode": "NotRequired[Literal['lexical', 'hybrid']]",
        "allow_degraded": "NotRequired[bool]",
        "valid_at": "NotRequired[float]",
        "include_ended": "NotRequired[bool]",
    },
)

MemorySearchResultCoverageSemantic = TypedDict(
    "MemorySearchResultCoverageSemantic",
    {
        "scored": "float",
        "missing": "float",
        "invalid": "float",
    },
)

MemorySearchResultCoverage = TypedDict(
    "MemorySearchResultCoverage",
    {
        "candidate_limit": "float",
        "lexical_candidates": "float",
        "semantic": "Optional[MemorySearchResultCoverageSemantic]",
    },
)

MemorySearchResultResultsItemStaleReason = TypedDict(
    "MemorySearchResultResultsItemStaleReason",
    {
        "kind": "str",
        "record_id": "NotRequired[str]",
        "observed_version": "NotRequired[float]",
    },
)

MemorySearchResultResultsItemRanks = TypedDict(
    "MemorySearchResultResultsItemRanks",
    {
        "lexical": "NotRequired[float]",
        "semantic": "NotRequired[float]",
        "expansion": "NotRequired[list[Optional[float]]]",
    },
)

MemorySearchResultResultsItem = TypedDict(
    "MemorySearchResultResultsItem",
    {
        "freshness": "NotRequired[Literal['current', 'stale', 'historical']]",
        "stale_reason": "NotRequired[Optional[MemorySearchResultResultsItemStaleReason]]",
        "dependency_versions": "NotRequired[dict[str, Optional[float]]]",
        "valid_time": "NotRequired[Optional[MemoryValidity]]",
        "vocabulary_version": "NotRequired[float]",
        "id": "str",
        "space_id": "str",
        "version": "float",
        "content": "str",
        "type": "str",
        "tier": "str",
        "importance": "float",
        "subject": "Optional[str]",
        "metadata": "dict[str, Any]",
        "source_ids": "list[str]",
        "depends_on": "list[str]",
        "created_at": "float",
        "claim": "NotRequired[Optional[MemoryClaim]]",
        "score": "float",
        "ranks": "MemorySearchResultResultsItemRanks",
    },
)

MemorySearchResult = TypedDict(
    "MemorySearchResult",
    {
        "ranking": "NotRequired[MemoryReputationRanking]",
        "expansion": "NotRequired[MemoryExpansionCoverage]",
        "coverage": "NotRequired[MemorySearchResultCoverage]",
        "space_id": "str",
        "generation": "float",
        "mode": "Literal['lexical', 'hybrid']",
        "model": "Optional[str]",
        "degraded": "list[str]",
        "results": "list[MemorySearchResultResultsItem]",
    },
)

MemorySource = TypedDict(
    "MemorySource",
    {
        "id": "str",
        "space_id": "str",
        "seq": "float",
        "session_id": "Optional[str]",
        "body": "Any",
        "content_hash": "str",
        "created_at": "float",
    },
)

MemorySourceRange = TypedDict(
    "MemorySourceRange",
    {
        "id": "str",
        "session_id": "Optional[str]",
        "content_hash": "str",
        "text_hash": "str",
        "representation": "Literal['utf8-source-text-v1']",
        "start": "float",
        "end": "float",
        "total_bytes": "float",
        "next_start": "Optional[float]",
        "text": "str",
    },
)

MemorySourceSearch = TypedDict(
    "MemorySourceSearch",
    {
        "query": "str",
        "expansion": "NotRequired[MemoryQueryExpansion]",
        "match": "NotRequired[Literal['all', 'any', 'phrase']]",
        "session_id": "NotRequired[str]",
        "limit": "NotRequired[float]",
    },
)

MemorySourceSearchResultResultsItemRanks = TypedDict(
    "MemorySourceSearchResultResultsItemRanks",
    {
        "lexical": "NotRequired[float]",
        "expansion": "NotRequired[list[Optional[float]]]",
    },
)

MemorySourceSearchResultResultsItem = TypedDict(
    "MemorySourceSearchResultResultsItem",
    {
        "id": "str",
        "seq": "float",
        "session_id": "Optional[str]",
        "content_hash": "str",
        "excerpt": "str",
        "score": "NotRequired[float]",
        "ranks": "NotRequired[MemorySourceSearchResultResultsItemRanks]",
    },
)

MemorySourceSearchResult = TypedDict(
    "MemorySourceSearchResult",
    {
        "expansion": "NotRequired[MemoryExpansionCoverage]",
        "space_id": "str",
        "generation": "float",
        "results": "list[MemorySourceSearchResultResultsItem]",
        "truncated": "bool",
    },
)

MemorySpace = TypedDict(
    "MemorySpace",
    {
        "retrieval_generation": "float",
        "id": "str",
        "owner_id": "str",
        "name": "str",
        "generation": "float",
        "status": "Literal['active', 'forgotten']",
        "created_at": "float",
        "metadata": "dict[str, Any]",
    },
)

MemoryStandingCredit = TypedDict(
    "MemoryStandingCredit",
    {
        "principal_id": "str",
        "kind": "str",
        "ref": "str",
        "amount": "float",
    },
)

MemoryStorageAmounts = TypedDict(
    "MemoryStorageAmounts",
    {
        "logical_bytes": "float",
        "sources": "float",
        "revisions": "float",
        "spaces": "float",
    },
)

MemoryStorageUsage = TypedDict(
    "MemoryStorageUsage",
    {
        "owner_id": "str",
        "usage": "MemoryStorageAmounts",
        "limits": "MemoryStorageAmounts",
        "over_limit": "list[Literal['logical_bytes', 'sources', 'revisions', 'spaces']]",
    },
)

MemoryTermEntity = TypedDict(
    "MemoryTermEntity",
    {
        "kind": "Literal['entity']",
        "id": "str",
    },
)

MemoryTermLiteral = TypedDict(
    "MemoryTermLiteral",
    {
        "kind": "Literal['literal']",
        "value": "Optional[Union[str, float, bool]]",
    },
)

MemoryTransferFragment = TypedDict(
    "MemoryTransferFragment",
    {
        "kind": "MemoryTransferKind",
        "id": "str",
        "version": "float",
        "offset": "float",
        "size": "float",
        "sha256": "str",
        "base64": "str",
    },
)

MemoryTransferHeaderCounts = TypedDict(
    "MemoryTransferHeaderCounts",
    {
        "source": "float",
        "record": "float",
        "revision": "float",
        "vocabulary": "float",
        "checkpoint": "float",
    },
)

MemoryTransferHeader = TypedDict(
    "MemoryTransferHeader",
    {
        "schema": "Literal['marina.memory.transfer.v1']",
        "origin_space": "str",
        "generation": "float",
        "counts": "MemoryTransferHeaderCounts",
    },
)

MemoryTransferListTransfersItem = TypedDict(
    "MemoryTransferListTransfersItem",
    {
        "id": "str",
        "header": "MemoryTransferHeader",
        "state": "Literal['receiving', 'ready', 'committed', 'aborted']",
        "position": "float",
        "sha256": "str",
        "bytes": "float",
        "next_cursor": "Optional[str]",
        "expires_at": "float",
        "expired": "bool",
    },
)

MemoryTransferList = TypedDict(
    "MemoryTransferList",
    {
        "transfers": "list[MemoryTransferListTransfersItem]",
        "next_cursor": "Optional[str]",
    },
)

MemoryTransferPage = TypedDict(
    "MemoryTransferPage",
    {
        "header": "MemoryTransferHeader",
        "position": "float",
        "previous": "str",
        "fragments": "list[MemoryTransferFragment]",
        "done": "bool",
        "sha256": "str",
        "next_cursor": "Optional[str]",
    },
)

MemoryTransferStatus = TypedDict(
    "MemoryTransferStatus",
    {
        "id": "str",
        "header": "MemoryTransferHeader",
        "state": "Literal['receiving', 'ready', 'committed', 'aborted']",
        "position": "float",
        "sha256": "str",
        "bytes": "float",
        "next_cursor": "Optional[str]",
        "expires_at": "float",
    },
)

MemoryValidity = TypedDict(
    "MemoryValidity",
    {
        "from": "Optional[float]",
        "until": "Optional[float]",
    },
)

MemoryVariable = TypedDict(
    "MemoryVariable",
    {
        "variable": "str",
        "type": "Literal['entity', 'symbol', 'string', 'number', 'boolean', 'null']",
    },
)

MemoryVocabulary = TypedDict(
    "MemoryVocabulary",
    {
        "version": "float",
        "definition": "MemoryVocabularyDefinition",
    },
)

MemoryVocabularyDefinitionPredicatesValue = TypedDict(
    "MemoryVocabularyDefinitionPredicatesValue",
    {
        "object": "Literal['entity', 'string', 'number', 'boolean', 'null']",
        "cardinality": "Literal['one', 'many']",
        "description": "NotRequired[str]",
    },
)

MemoryVocabularyDefinition = TypedDict(
    "MemoryVocabularyDefinition",
    {
        "closed": "bool",
        "predicates": "dict[str, MemoryVocabularyDefinitionPredicatesValue]",
    },
)

MeResponse = TypedDict(
    "MeResponse",
    {
        "principal_id": "str",
        "credential_id": "str",
        "scopes": "list[str]",
    },
)

# A canvas or panel failure. `code` is present on some failures only.
PanelError = TypedDict(
    "PanelError",
    {
        "error": "str",
        "code": "NotRequired[str]",
    },
)

PanelInteractionInput = TypedDict(
    "PanelInteractionInput",
    {
        "revision": "str",
        "componentId": "str",
        "fields": "NotRequired[dict[str, Union[str, bool]]]",
        "value": "NotRequired[Union[str, bool]]",
        "requestId": "NotRequired[str]",
        "sourceId": "NotRequired[str]",
        "capabilityRevision": "NotRequired[float]",
    },
)

# Read adapters, not grants. Every fetch still passes through the resource's own authorization.
# Keep side-effecting GETs (notably entities/:name/canvas), credentials and arbitrary URLs out.
# Parameters are encoded as individual path segments; query keys are declared per adapter.
PanelResourceDefinition = TypedDict(
    "PanelResourceDefinition",
    {
        "id": "str",
        "path": "str",
        "parameters": "list[str]",
        "query": "list[str]",
    },
)

PanelResourcesResponse = TypedDict(
    "PanelResourcesResponse",
    {
        "schema": "Literal['marina.panel-resources.v1']",
        "resources": "list[PanelResourceDefinition]",
    },
)

PanelSource2 = TypedDict(
    "PanelSource2",
    {
        "kind": "Literal['task', 'note', 'participant', 'run', 'coding']",
        "id": "str",
    },
)

PanelSourceArtifact = TypedDict(
    "PanelSourceArtifact",
    {
        "kind": "Literal['artifact']",
        "id": "str",
        "sessionId": "str",
    },
)

PanelSourceMemory = TypedDict(
    "PanelSourceMemory",
    {
        "kind": "Literal['memory']",
        "id": "str",
        "spaceId": "str",
    },
)

PanelSourceCanvas = TypedDict(
    "PanelSourceCanvas",
    {
        "kind": "Literal['canvas']",
        "id": "str",
        "canvasId": "str",
    },
)

PanelSourceFeed = TypedDict(
    "PanelSourceFeed",
    {
        "kind": "Literal['feed']",
        "limit": "NotRequired[float]",
        "filter": "NotRequired[str]",
    },
)

PlanRequest = TypedDict(
    "PlanRequest",
    {
        "task": "str",
        "use_model": "NotRequired[bool]",
        "steps": "NotRequired[list[MemoryPlanStep]]",
        "max_results": "NotRequired[float]",
        "max_bytes": "NotRequired[float]",
    },
)

PredictionEstimateBinary = TypedDict(
    "PredictionEstimateBinary",
    {
        "type": "Literal['binary']",
        "probability": "NotRequired[float]",
    },
)

PredictionEstimateNumber = TypedDict(
    "PredictionEstimateNumber",
    {
        "type": "Literal['number']",
        "value": "NotRequired[float]",
        "sd": "NotRequired[float]",
        "unit": "NotRequired[str]",
    },
)

PredictionEstimateChoiceOptionsItem = TypedDict(
    "PredictionEstimateChoiceOptionsItem",
    {
        "id": "str",
        "label": "str",
        "probability": "NotRequired[float]",
    },
)

PredictionEstimateChoice = TypedDict(
    "PredictionEstimateChoice",
    {
        "type": "Literal['choice']",
        "selected": "NotRequired[str]",
        "options": "list[PredictionEstimateChoiceOptionsItem]",
    },
)

PredictionShapeBinary = TypedDict(
    "PredictionShapeBinary",
    {
        "type": "Literal['binary']",
    },
)

PredictionShapeNumber = TypedDict(
    "PredictionShapeNumber",
    {
        "type": "Literal['number']",
        "unit": "NotRequired[str]",
    },
)

PredictionShapeChoiceOptionsItem = TypedDict(
    "PredictionShapeChoiceOptionsItem",
    {
        "id": "str",
        "label": "str",
    },
)

PredictionShapeChoice = TypedDict(
    "PredictionShapeChoice",
    {
        "type": "Literal['choice']",
        "options": "list[PredictionShapeChoiceOptionsItem]",
    },
)

PublishedPanelNodeData = TypedDict(
    "PublishedPanelNodeData",
    {
        "panelRevision": "NotRequired[str]",
    },
)

PublishedPanelNode = TypedDict(
    "PublishedPanelNode",
    {
        "id": "str",
        "canvas_id": "str",
        "type": "str",
        "creator_name": "str",
        "updated_at": "float",
        "data": "PublishedPanelNodeData",
    },
)

PublishPanelRequest = TypedDict(
    "PublishPanelRequest",
    {
        "type": "Literal['a2ui']",
        "data": "A2UINodeData",
    },
)

PublishRequest = TypedDict(
    "PublishRequest",
    {
        "events": "list[RoutingEventInput]",
    },
)

PublishResponse = TypedDict(
    "PublishResponse",
    {
        "events": "list[RoutingEvent]",
    },
)

ReaffirmRequest = TypedDict(
    "ReaffirmRequest",
    {
        "id": "str",
        "expected_version": "float",
        "dependency_versions": "dict[str, float]",
        "content": "NotRequired[str]",
    },
)

ReindexRequest = TypedDict(
    "ReindexRequest",
    {
        "expected_generation": "float",
        "cursor": "NotRequired[str]",
        "limit": "NotRequired[float]",
    },
)

ReindexResponse = TypedDict(
    "ReindexResponse",
    {
        "id": "str",
        "version": "NotRequired[float]",
        "job_id": "NotRequired[str]",
        "seq": "NotRequired[float]",
        "generation": "float",
        "model": "str",
        "job_ids": "list[str]",
        "examined": "float",
        "next_cursor": "Optional[str]",
    },
)

RenewResidentRequest = TypedDict(
    "RenewResidentRequest",
    {
        "sessionId": "str",
    },
)

RenewResidentResponse = TypedDict(
    "RenewResidentResponse",
    {
        "name": "str",
        "credential": "ResidentCredential",
    },
)

ReportResidentAttentionResponse = TypedDict(
    "ReportResidentAttentionResponse",
    {
        "name": "str",
        "recorded": "float",
    },
)

# How a supervised resident's attention bridge decides and relays.
ResidentAttentionPolicy = TypedDict(
    "ResidentAttentionPolicy",
    {
        "mode": "Literal['focused', 'balanced', 'open']",
        "threshold": "float",
        "relay": "Literal['all', 'explicit']",
    },
)

ResidentAttentionReportWakesItem = TypedDict(
    "ResidentAttentionReportWakesItem",
    {
        "ref": "NotRequired[str]",
        "source": "str",
        "decision": "Literal['now', 'next', 'context', 'drop']",
        "reason": "str",
        "hop": "float",
        "steered": "bool",
        "at": "float",
    },
)

ResidentAttentionReportOutcomesItem = TypedDict(
    "ResidentAttentionReportOutcomesItem",
    {
        "ref": "str",
        "worked": "bool",
    },
)

# The resident's current presence, when it changed.
ResidentAttentionReportStatus = TypedDict(
    "ResidentAttentionReportStatus",
    {
        "status": "Literal['starting', 'idle', 'running', 'waiting', 'stopped', 'failed', 'disconnected']",
        "steer": "Literal['mid-turn', 'next-turn', 'none']",
    },
)

# `POST /api/routing/residents/:name/attention`: bridge decisions and presence.
ResidentAttentionReport = TypedDict(
    "ResidentAttentionReport",
    {
        "sessionId": "str",
        "wakes": "NotRequired[list[ResidentAttentionReportWakesItem]]",
        "outcomes": "NotRequired[list[ResidentAttentionReportOutcomesItem]]",
        "status": "NotRequired[ResidentAttentionReportStatus]",
    },
)

# A resident's world credential, returned once and never stored by the server.
ResidentCredential = TypedDict(
    "ResidentCredential",
    {
        "token": "str",
        "expiresAt": "float",
    },
)

# `POST /api/routing/residents` input: enrol the agent of one owned run session.
ResidentEnrolInput = TypedDict(
    "ResidentEnrolInput",
    {
        "sessionId": "str",
        "name": "NotRequired[str]",
        "proposedName": "NotRequired[str]",
        "room": "NotRequired[str]",
    },
)

ResidentEnrolment = TypedDict(
    "ResidentEnrolment",
    {
        "name": "str",
        "vendor": "str",
        "owner": "NotRequired[str]",
        "room": "NotRequired[str]",
        "reused": "bool",
        "nameSource": "NotRequired[ResidentNameSource]",
        "credential": "ResidentCredential",
        "attention": "NotRequired[ResidentAttentionPolicy]",
    },
)

ResolveAttemptRequest = TypedDict(
    "ResolveAttemptRequest",
    {
        "value": "Any",
    },
)

ResolveAttemptResponse = TypedDict(
    "ResolveAttemptResponse",
    {
        "answerId": "float",
        "loss": "Optional[float]",
    },
)

ResolveRequest = TypedDict(
    "ResolveRequest",
    {
        "policy": "MemoryResolvePolicy",
        "competing": "list[str]",
        "rationale": "str",
        "valid_time": "NotRequired[Optional[MemoryValidity]]",
        "deadline_ms": "NotRequired[float]",
        "id": "str",
    },
)

ReviewAttemptRequest = TypedDict(
    "ReviewAttemptRequest",
    {
        "text": "str",
    },
)

ReviewRequest = TypedDict(
    "ReviewRequest",
    {
        "kind": "NotRequired[Literal['all', 'stale', 'competing', 'pending']]",
        "limit": "NotRequired[float]",
        "cursor": "NotRequired[str]",
    },
)

RevisePanelRequest = TypedDict(
    "RevisePanelRequest",
    {
        "revision": "str",
        "data": "A2UINodeData",
    },
)

ReviseRequest = TypedDict(
    "ReviseRequest",
    {
        "dependency_versions": "NotRequired[dict[str, float]]",
        "valid_time": "NotRequired[Optional[MemoryValidity]]",
        "expected_vocabulary_version": "NotRequired[float]",
        "content": "str",
        "type": "NotRequired[Literal['fact', 'observation', 'decision', 'inference', 'skill', 'episode']]",
        "tier": "NotRequired[Literal['fact', 'reflection', 'skill']]",
        "importance": "NotRequired[float]",
        "subject": "NotRequired[str]",
        "metadata": "NotRequired[dict[str, Any]]",
        "source_ids": "NotRequired[list[str]]",
        "depends_on": "NotRequired[list[str]]",
        "claim": "NotRequired[Optional[MemoryClaim]]",
        "expected_version": "float",
    },
)

RevokeResidentRequest = TypedDict(
    "RevokeResidentRequest",
    {
        "sessionId": "str",
    },
)

RevokeResidentResponse = TypedDict(
    "RevokeResidentResponse",
    {
        "name": "str",
        "revoked": "float",
    },
)

RevokeSupervisionResponse = TypedDict(
    "RevokeSupervisionResponse",
    {
        "revoked": "bool",
    },
)

# References to Marina's existing channel_messages; this is not a second conversation log.
RoutingChannelMessage = TypedDict(
    "RoutingChannelMessage",
    {
        "id": "float",
        "channelId": "str",
        "senderId": "str",
        "senderName": "str",
        "content": "str",
        "createdAt": "float",
    },
)

RoutingChannelPage = TypedDict(
    "RoutingChannelPage",
    {
        "messages": "list[RoutingChannelMessage]",
        "nextCursor": "float",
        "hasMore": "bool",
    },
)

RoutingChannelReceipt = TypedDict(
    "RoutingChannelReceipt",
    {
        "message": "RoutingChannelMessage",
        "duplicate": "bool",
    },
)

RoutingEvent = TypedDict(
    "RoutingEvent",
    {
        "id": "str",
        "kind": "str",
        "payload": "Any",
        "sessionId": "str",
        "sequence": "float",
        "createdAt": "float",
    },
)

RoutingEventInput = TypedDict(
    "RoutingEventInput",
    {
        "id": "str",
        "kind": "str",
        "payload": "Any",
    },
)

RoutingEventPage = TypedDict(
    "RoutingEventPage",
    {
        "events": "list[RoutingEvent]",
        "nextCursor": "float",
        "lastSequence": "float",
        "hasMore": "bool",
        "gap": "bool",
    },
)

# Version 1: transport-neutral participants. Capabilities describe clients, not permissions.
RoutingJoin = TypedDict(
    "RoutingJoin",
    {
        "clientKey": "str",
        "label": "str",
        "kind": "str",
        "groupId": "NotRequired[str]",
        "capabilities": "NotRequired[list[str]]",
    },
)

RoutingMessage = TypedDict(
    "RoutingMessage",
    {
        "clientMessageId": "str",
        "targetId": "str",
        "kind": "str",
        "payload": "Any",
        "id": "str",
        "sourceId": "str",
        "status": "Literal['queued', 'acknowledged']",
        "createdAt": "float",
        "acknowledgedAt": "Optional[float]",
    },
)

RoutingOverview = TypedDict(
    "RoutingOverview",
    {
        "items": "list[RoutingOverviewItem]",
        "total": "float",
        "nextCursor": "Optional[str]",
    },
)

# Account-scoped observer projection; runtime data is reported by the participant.
RoutingOverviewItem = TypedDict(
    "RoutingOverviewItem",
    {
        "session": "RoutingSession",
        "runtime": "Any",
        "lastDelivery": "Optional[RoutingEvent]",
        "owned": "bool",
    },
)

RoutingSend = TypedDict(
    "RoutingSend",
    {
        "clientMessageId": "str",
        "targetId": "str",
        "kind": "str",
        "payload": "Any",
    },
)

RoutingSession = TypedDict(
    "RoutingSession",
    {
        "id": "str",
        "ownerId": "str",
        "clientKey": "str",
        "label": "str",
        "kind": "str",
        "groupId": "Optional[str]",
        "capabilities": "list[str]",
        "state": "Literal['active', 'left']",
        "createdAt": "float",
        "lastSeenAt": "float",
        "lastSequence": "float",
    },
)

RoutingSessionPage = TypedDict(
    "RoutingSessionPage",
    {
        "sessions": "list[RoutingSession]",
        "nextCursor": "Optional[str]",
    },
)

RoutingSyncInputPublicationsItem = TypedDict(
    "RoutingSyncInputPublicationsItem",
    {
        "sessionId": "str",
        "events": "list[RoutingEventInput]",
    },
)

RoutingSyncInputAcknowledgmentsItem = TypedDict(
    "RoutingSyncInputAcknowledgmentsItem",
    {
        "sessionId": "str",
        "messageId": "str",
    },
)

RoutingSyncInput = TypedDict(
    "RoutingSyncInput",
    {
        "publications": "NotRequired[list[RoutingSyncInputPublicationsItem]]",
        "acknowledgments": "NotRequired[list[RoutingSyncInputAcknowledgmentsItem]]",
        "inboxes": "NotRequired[list[str]]",
    },
)

RoutingSyncResultInboxesItem = TypedDict(
    "RoutingSyncResultInboxesItem",
    {
        "sessionId": "str",
        "messages": "list[RoutingMessage]",
    },
)

RoutingSyncResult = TypedDict(
    "RoutingSyncResult",
    {
        "inboxes": "list[RoutingSyncResultInboxesItem]",
    },
)

RunRuleRequest = TypedDict(
    "RunRuleRequest",
    {
        "id": "str",
        "expected_version": "float",
        "valid_at": "NotRequired[float]",
    },
)

RuntimeControlLaunch = TypedDict(
    "RuntimeControlLaunch",
    {
        "action": "Literal['launch']",
        "adapter": "str",
        "label": "str",
        "directory": "NotRequired[str]",
        "workspace": "NotRequired[Literal['worktree', 'shared']]",
        "model": "NotRequired[str]",
        "effort": "NotRequired[str]",
        "prompt": "NotRequired[str]",
        "name": "NotRequired[str]",
        "room": "NotRequired[str]",
    },
)

RuntimeControlPrompt = TypedDict(
    "RuntimeControlPrompt",
    {
        "action": "Literal['prompt']",
        "text": "str",
    },
)

RuntimeControl3 = TypedDict(
    "RuntimeControl3",
    {
        "action": "Literal['interrupt', 'stop', 'resume', 'detach']",
    },
)

RuntimeControlRespond = TypedDict(
    "RuntimeControlRespond",
    {
        "action": "Literal['respond']",
        "requestId": "str",
        "allow": "bool",
        "answer": "NotRequired[str]",
    },
)

RuntimeControlAttention = TypedDict(
    "RuntimeControlAttention",
    {
        "action": "Literal['attention']",
        "mode": "NotRequired[Literal['focused', 'balanced', 'open']]",
        "threshold": "NotRequired[float]",
        "relay": "NotRequired[Literal['all', 'explicit']]",
    },
)

RuntimeRequest = TypedDict(
    "RuntimeRequest",
    {
        "id": "str",
        "kind": "Literal['permission', 'question']",
        "title": "str",
        "input": "Any",
        "choices": "NotRequired[list[str]]",
    },
)

RuntimeResponse = TypedDict(
    "RuntimeResponse",
    {
        "state": "Optional[RuntimeState]",
    },
)

RuntimeStateAdaptersItem = TypedDict(
    "RuntimeStateAdaptersItem",
    {
        "id": "str",
        "label": "str",
    },
)

RuntimeState = TypedDict(
    "RuntimeState",
    {
        "version": "Literal[1]",
        "role": "Literal['supervisor', 'agent', 'attachment']",
        "status": "Literal['starting', 'idle', 'running', 'waiting', 'stopped', 'failed', 'disconnected']",
        "mode": "Literal['managed', 'attached']",
        "adapter": "str",
        "supervisorId": "str",
        "cwd": "str",
        "nativeSessionId": "NotRequired[str]",
        "model": "NotRequired[str]",
        "effort": "NotRequired[str]",
        "resumeSupported": "NotRequired[bool]",
        "request": "NotRequired[RuntimeRequest]",
        "error": "NotRequired[str]",
        "adapters": "NotRequired[list[RuntimeStateAdaptersItem]]",
        "root": "NotRequired[str]",
        "activeCount": "NotRequired[float]",
        "resident": "NotRequired[str]",
        "updatedAt": "float",
    },
)

SaveCheckpointRequest = TypedDict(
    "SaveCheckpointRequest",
    {
        "expected_version": "float",
        "data": "dict[str, Any]",
        "source_cursor": "NotRequired[float]",
        "source_ids": "NotRequired[list[str]]",
    },
)

SaveRuleRequest = TypedDict(
    "SaveRuleRequest",
    {
        "rule": "MemoryRule",
        "id": "NotRequired[str]",
        "expected_version": "NotRequired[float]",
        "source_ids": "NotRequired[list[str]]",
    },
)

SaveVocabularyRequest = TypedDict(
    "SaveVocabularyRequest",
    {
        "expected_version": "float",
        "definition": "MemoryVocabularyDefinition",
    },
)

SendChannelRequest = TypedDict(
    "SendChannelRequest",
    {
        "clientMessageId": "str",
        "text": "str",
    },
)

SourceHeadersResponseSourcesItem = TypedDict(
    "SourceHeadersResponseSourcesItem",
    {
        "id": "str",
        "space_id": "str",
        "seq": "float",
        "session_id": "Optional[str]",
        "content_hash": "str",
        "created_at": "float",
    },
)

SourceHeadersResponse = TypedDict(
    "SourceHeadersResponse",
    {
        "sources": "list[SourceHeadersResponseSourcesItem]",
        "next_cursor": "Optional[float]",
    },
)

SourcesResponse = TypedDict(
    "SourcesResponse",
    {
        "sources": "list[MemorySource]",
        "next_cursor": "float",
    },
)

SpacesResponse = TypedDict(
    "SpacesResponse",
    {
        "spaces": "list[MemorySpace]",
    },
)

StartInvestigationRequestLimits = TypedDict(
    "StartInvestigationRequestLimits",
    {
        "calls": "NotRequired[float]",
        "concurrency": "NotRequired[float]",
        "timeoutMs": "NotRequired[float]",
    },
)

StartInvestigationRequest = TypedDict(
    "StartInvestigationRequest",
    {
        "kind": "InvestigationKind",
        "question": "str",
        "answer": "NotRequired[PredictionShape]",
        "context": "NotRequired[str]",
        "horizon": "NotRequired[str]",
        "asOf": "NotRequired[str]",
        "caseId": "NotRequired[str]",
        "parentAttemptId": "NotRequired[str]",
        "runs": "NotRequired[float]",
        "limits": "NotRequired[StartInvestigationRequestLimits]",
        "idempotencyKey": "str",
    },
)

StartInvestigationResponse = TypedDict(
    "StartInvestigationResponse",
    {
        "attempt": "InvestigationAttempt",
        "created": "bool",
    },
)

# A routing-only supervision credential (supervised residents).
SupervisionCredentialGrant = TypedDict(
    "SupervisionCredentialGrant",
    {
        "credentialId": "str",
        "token": "str",
        "expiresAt": "float",
    },
)

WorkflowRequest = TypedDict(
    "WorkflowRequest",
    {
        "action": "Literal['help', 'start', 'tasks', 'run', 'finish', 'feedback', 'resume', 'export_episode', 'import_episode', 'save_recipe', 'recipes', 'use_recipe', 'changes', 'watch', 'poll', 'ack', 'unwatch']",
    },
)

A2UIComponentType = Literal['Text', 'Button', 'TextField', 'CheckBox', 'DateTimeInput', 'Row', 'Column', 'Card', 'Surface', 'DataTable', 'Timeline', 'Resource']

AbortTransferRequest = dict[str, Any]

AcknowledgeMessageRequest = dict[str, Any]

AssistCancelRequest = dict[str, Any]

AssistClaimRequest = dict[str, Any]

AssistReadResponse = Any

CancelAttemptRequest = dict[str, Any]

CanvasesResponse = list["CanvasesResponseItem"]

CapabilitiesResponse = dict[str, Any]

ExportResponse = dict[str, Any]

HeartbeatRequest = dict[str, Any]

InvestigationAccess = Literal['read', 'work']

InvestigationKind = Literal['prediction', 'research']

InvestigationState = Literal['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']

IssueSupervisionRequest = dict[str, Any]

KnowledgeGraphResponse = dict[str, Any]

LeaveRequest = dict[str, Any]

MemoryAnswer = Union["MemoryAnswerAnswered", "MemoryAnswerAbstained"]

MemoryBinding = Union["MemoryTerm", "MemoryBinding2"]

MemoryCacheResult = Union["MemoryCacheResult1", "MemoryCacheResult2"]

MemoryCitation = Union["MemoryCitationRecord", "MemoryCitationSource"]

MemoryFederatedEntry = dict[str, Any]

# Explicit remote provenance; mounts are configured by the operator, never URLs.
MemoryFederatedPin = dict[str, Any]

MemoryGraphAction = Literal['create_entities', 'create_relations', 'add_observations', 'delete_entities', 'delete_observations', 'delete_relations', 'read_graph', 'search_nodes', 'open_nodes']

MemoryHelperRole = Literal['librarian', 'reflector', 'evaluator']

MemoryResolutionRole = Literal['winner', 'superseded', 'peer', 'pending']

MemoryResolutionStatus = Literal['applied', 'pending', 'confirmed', 'superseded', 'retired']

# Typed write-time operators over the review queue. Every policy writes an
# append-only audit row; none deletes history.
MemoryResolvePolicy = Literal['last_writer_wins', 'evidence_weighted', 'await_confirmation', 'keep_both']

MemoryRetrievedEvidence = Union["MemoryRetrievedEvidenceRecord", "MemoryRetrievedEvidenceUtf8SourceTextV1"]

MemorySelection = Literal['sources_first', 'balanced', 'records_first']

MemoryTerm = Union["MemoryTermEntity", "MemoryTermLiteral"]

MemoryTransferKind = Literal['source', 'record', 'revision', 'vocabulary', 'checkpoint']

PanelSource = Union["CatalogPanelSource", "PanelSource2", "PanelSourceArtifact", "PanelSourceMemory", "PanelSourceCanvas", "PanelSourceFeed"]

PredictionEstimate = Union["PredictionEstimateBinary", "PredictionEstimateNumber", "PredictionEstimateChoice"]

PredictionShape = Union["PredictionShapeBinary", "PredictionShapeNumber", "PredictionShapeChoice"]

RenewSupervisionRequest = dict[str, Any]

# Where a resident's name came from.
ResidentNameSource = Literal['requested', 'proposed', 'generated']

RevokeSupervisionRequest = dict[str, Any]

RuntimeControl = Union["RuntimeControlLaunch", "RuntimeControlPrompt", "RuntimeControl3", "RuntimeControlRespond", "RuntimeControlAttention"]

SelectAttemptRequest = dict[str, Any]

WorkflowResponse = dict[str, Any]

# ─── Operations ───────────────────────────────────────────────────────────

class MemoryApi(HttpApi):
    """The memory operations of marina.http.v1, typed. Anything newer: `call(...)`."""

    def __init__(self, base_url: str, token: TokenSource, timeout: float = 35.0) -> None:
        super().__init__(base_url, token, "memory", timeout)

    def capabilities(self) -> CapabilitiesResponse:
        """What this memory service offers. `GET /v1/memory`"""
        return self._call(_operation("capabilities"))

    def me(self) -> MeResponse:
        """Who the presented credential is. `GET /v1/memory/me`"""
        return self._call(_operation("me"))

    def usage(self) -> MemoryStorageUsage:
        """Storage used and its limits. `GET /v1/memory/usage`"""
        return self._call(_operation("usage"))

    def spaces(self) -> SpacesResponse:
        """Spaces this credential can read. `GET /v1/memory/spaces`"""
        return self._call(_operation("spaces"))

    def create_space(self, body: CreateSpaceRequest, *, idempotency_key: Optional[str] = None) -> MemoryReceipt:
        """Create a space. `POST /v1/memory/spaces`"""
        return self._call(_operation("createSpace"), body=body, idempotency_key=idempotency_key)

    def space(self, space: str) -> MemorySpace:
        """One space. `GET /v1/memory/spaces/{space}`"""
        return self._call(_operation("space"), space=space)

    def remember(self, space: str, body: MemoryRecordInput, *, idempotency_key: Optional[str] = None) -> MemoryReceipt:
        """Write a record. `POST /v1/memory/spaces/{space}/records`"""
        return self._call(_operation("remember"), body=body, idempotency_key=idempotency_key, space=space)

    def get(self, space: str, id: str, *, version: Optional[float] = None) -> MemoryRecord:
        """Read a record, or one of its earlier versions. `GET /v1/memory/spaces/{space}/records/{id}`"""
        return self._call(_operation("get"), space=space, id=id, version=version)

    def revise(self, space: str, id: str, body: ReviseRequest, *, idempotency_key: Optional[str] = None) -> MemoryReceipt:
        """Revise a record (compare-and-set on its version). `PATCH /v1/memory/spaces/{space}/records/{id}`"""
        return self._call(_operation("revise"), body=body, idempotency_key=idempotency_key, space=space, id=id)

    def search(self, space: str, body: MemorySearchInput) -> MemorySearchResult:
        """Search records. `POST /v1/memory/spaces/{space}/search`"""
        return self._call(_operation("search"), body=body, space=space)

    def context(self, space: str, body: ContextRequest) -> ContextResponse:
        """A prompt-ready context block with citations, within a token budget. `POST /v1/memory/spaces/{space}/context`"""
        return self._call(_operation("context"), body=body, space=space)

    def query(self, space: str, body: MemoryQuery) -> MemoryQueryResult:
        """Structured query over claims. `POST /v1/memory/spaces/{space}/query`"""
        return self._call(_operation("query"), body=body, space=space)

    def graph(self, space: str, body: MemoryGraphQuery) -> MemoryGraphResult:
        """Walk the claim graph from a subject. `POST /v1/memory/spaces/{space}/graph`"""
        return self._call(_operation("graph"), body=body, space=space)

    def join(self, space: str, body: MemoryJoin, *, idempotency_key: Optional[str] = None) -> MemoryJoinResult:
        """Join claim patterns. `POST /v1/memory/spaces/{space}/join`"""
        return self._call(_operation("join"), body=body, idempotency_key=idempotency_key, space=space)

    def save_rule(self, space: str, body: SaveRuleRequest, *, idempotency_key: Optional[str] = None) -> MemoryReceipt:
        """Save an inference rule. `POST /v1/memory/spaces/{space}/rules`"""
        return self._call(_operation("saveRule"), body=body, idempotency_key=idempotency_key, space=space)

    def run_rule(self, space: str, body: RunRuleRequest, *, idempotency_key: Optional[str] = None) -> MemoryRuleResult:
        """Run a rule without writing. `POST /v1/memory/spaces/{space}/rules/run`"""
        return self._call(_operation("runRule"), body=body, idempotency_key=idempotency_key, space=space)

    def materialize_rule(self, space: str, body: MaterializeRuleRequest, *, idempotency_key: Optional[str] = None) -> MaterializeRuleResponse:
        """Run a rule and write what it infers. `POST /v1/memory/spaces/{space}/rules/materialize`"""
        return self._call(_operation("materializeRule"), body=body, idempotency_key=idempotency_key, space=space)

    def knowledge_graph(self, space: str, body: KnowledgeGraphRequest) -> KnowledgeGraphResponse:
        """Entity/relation/observation graph operations. `POST /v1/memory/spaces/{space}/knowledge_graph`"""
        return self._call(_operation("knowledgeGraph"), body=body, space=space)

    def review(self, space: str, body: ReviewRequest) -> MemoryReviewResult:
        """Records that need a decision: stale, competing or pending. `POST /v1/memory/spaces/{space}/review`"""
        return self._call(_operation("review"), body=body, space=space)

    def reaffirm(self, space: str, body: ReaffirmRequest, *, idempotency_key: Optional[str] = None) -> MemoryReceipt:
        """Confirm a stale record still holds against its dependencies. `POST /v1/memory/spaces/{space}/reaffirm`"""
        return self._call(_operation("reaffirm"), body=body, idempotency_key=idempotency_key, space=space)

    def resolve(self, space: str, body: ResolveRequest, *, idempotency_key: Optional[str] = None) -> MemoryResolveResult:
        """Settle a contradiction: keep the head, close its rivals. `POST /v1/memory/spaces/{space}/resolve`"""
        return self._call(_operation("resolve"), body=body, idempotency_key=idempotency_key, space=space)

    def adopt(self, space: str, body: MemoryAdoptInput, *, idempotency_key: Optional[str] = None) -> MemoryAdoptResult:
        """Adopt an answered assistance proposal into this space. `POST /v1/memory/spaces/{space}/adopt`"""
        return self._call(_operation("adopt"), body=body, idempotency_key=idempotency_key, space=space)

    def acknowledge(self, space: str, body: AcknowledgeRequest, *, idempotency_key: Optional[str] = None) -> AcknowledgeResponse:
        """Acknowledge change notifications by key. `POST /v1/memory/spaces/{space}/acknowledge`"""
        return self._call(_operation("acknowledge"), body=body, idempotency_key=idempotency_key, space=space)

    def forget(self, space: str, body: ForgetMemoryInput, *, idempotency_key: Optional[str] = None) -> MemoryReceipt:
        """Erase records or sources. `POST /v1/memory/spaces/{space}/forget`"""
        return self._call(_operation("forget"), body=body, idempotency_key=idempotency_key, space=space)

    def grant(self, space: str, body: GrantRequest, *, idempotency_key: Optional[str] = None) -> MemoryReceipt:
        """Give a principal read or write access (null removes it). `POST /v1/memory/spaces/{space}/grants`"""
        return self._call(_operation("grant"), body=body, idempotency_key=idempotency_key, space=space)

    def reindex(self, space: str, body: ReindexRequest, *, idempotency_key: Optional[str] = None) -> ReindexResponse:
        """Re-embed records, one page at a time. `POST /v1/memory/spaces/{space}/reindex`"""
        return self._call(_operation("reindex"), body=body, idempotency_key=idempotency_key, space=space)

    def cache_get(self, space: str, body: MemoryCacheInput) -> MemoryCacheResult:
        """Read a cached derived value, if still valid. `POST /v1/memory/spaces/{space}/cache/get`"""
        return self._call(_operation("cacheGet"), body=body, space=space)

    def cache_put(self, space: str, body: MemoryCacheWrite, *, idempotency_key: Optional[str] = None) -> MemoryReceipt:
        """Cache a derived value pinned to the records and sources it used. `POST /v1/memory/spaces/{space}/cache/put`"""
        return self._call(_operation("cachePut"), body=body, idempotency_key=idempotency_key, space=space)

    def cache_delete(self, space: str, body: MemoryCacheInput, *, idempotency_key: Optional[str] = None) -> CacheDeleteResponse:
        """Drop a cached value. `POST /v1/memory/spaces/{space}/cache/delete`"""
        return self._call(_operation("cacheDelete"), body=body, idempotency_key=idempotency_key, space=space)

    def plan(self, space: str, body: PlanRequest) -> MemoryPlan:
        """Plan the retrieval steps for a task. `POST /v1/memory/spaces/{space}/plan`"""
        return self._call(_operation("plan"), body=body, space=space)

    def execute_plan(self, space: str, body: MemoryPlan) -> MemoryPlanResult:
        """Run a retrieval plan. `POST /v1/memory/spaces/{space}/execute_plan`"""
        return self._call(_operation("executePlan"), body=body, space=space)

    def retrieve(self, space: str, body: MemoryRetrievalInput) -> MemoryRetrievalResult:
        """Find and read citable evidence in one bounded request. `POST /v1/memory/spaces/{space}/retrieve`"""
        return self._call(_operation("retrieve"), body=body, space=space)

    def retrieve_cached(self, space: str, body: MemoryCachedRetrievalInput) -> MemoryCachedRetrievalResult:
        """Retrieve, reusing a cached result while its evidence is unchanged. `POST /v1/memory/spaces/{space}/retrieve_cached`"""
        return self._call(_operation("retrieveCached"), body=body, space=space)

    def federated_retrieve(self, space: str, body: FederatedRetrieveRequest) -> MemoryFederatedRetrievalResult:
        """Retrieve across mounted peer spaces. `POST /v1/memory/spaces/{space}/federated_retrieve`"""
        return self._call(_operation("federatedRetrieve"), body=body, space=space)

    def federation_mounts(self, space: str) -> FederationMountsResponse:
        """Peer spaces this principal can search. `GET /v1/memory/spaces/{space}/federation_mounts`"""
        return self._call(_operation("federationMounts"), space=space)

    def federated_search(self, space: str, body: MemoryFederatedSearch) -> MemoryFederatedResult:
        """Search mounted peer spaces. `POST /v1/memory/spaces/{space}/federated_search`"""
        return self._call(_operation("federatedSearch"), body=body, space=space)

    def federated_read(self, space: str, body: MemoryFederatedRead) -> FederatedReadResponse:
        """Read one item from a mounted peer space. `POST /v1/memory/spaces/{space}/federated_read`"""
        return self._call(_operation("federatedRead"), body=body, space=space)

    def vocabulary(self, space: str, *, version: Optional[float] = None) -> MemoryVocabulary:
        """The space's vocabulary (current, or a version). `GET /v1/memory/spaces/{space}/vocabulary`"""
        return self._call(_operation("vocabulary"), space=space, version=version)

    def save_vocabulary(self, space: str, body: SaveVocabularyRequest, *, idempotency_key: Optional[str] = None) -> MemoryReceipt:
        """Replace the vocabulary (compare-and-set on its version). `POST /v1/memory/spaces/{space}/vocabulary`"""
        return self._call(_operation("saveVocabulary"), body=body, idempotency_key=idempotency_key, space=space)

    def sources(self, space: str, *, after: Optional[float] = None, limit: Optional[float] = None) -> SourcesResponse:
        """Sources after a cursor, oldest first. `GET /v1/memory/spaces/{space}/sources`"""
        return self._call(_operation("sources"), space=space, after=after, limit=limit)

    def capture(self, space: str, body: CaptureRequest, *, idempotency_key: Optional[str] = None) -> MemoryReceipt:
        """Capture a source (raw evidence). `POST /v1/memory/spaces/{space}/sources`"""
        return self._call(_operation("capture"), body=body, idempotency_key=idempotency_key, space=space)

    def capture_batch(self, space: str, body: CaptureBatchRequest, *, idempotency_key: Optional[str] = None) -> CaptureBatchResponse:
        """Capture several sources, each with its own key. `POST /v1/memory/spaces/{space}/sources/batch`"""
        return self._call(_operation("captureBatch"), body=body, idempotency_key=idempotency_key, space=space)

    def source_headers(self, space: str, *, after: Optional[float] = None, limit: Optional[float] = None) -> SourceHeadersResponse:
        """Source headers (no bodies) after a cursor. `GET /v1/memory/spaces/{space}/source_headers`"""
        return self._call(_operation("sourceHeaders"), space=space, after=after, limit=limit)

    def source_range(self, space: str, id: str, *, start: Optional[float] = None, end: Optional[float] = None, text_hash: Optional[str] = None) -> MemorySourceRange:
        """Read a range of a source. `GET /v1/memory/spaces/{space}/sources/{id}`"""
        return self._call(_operation("sourceRange"), space=space, id=id, start=start, end=end, text_hash=text_hash)

    def source_search(self, space: str, body: MemorySourceSearch) -> MemorySourceSearchResult:
        """Search source text. `POST /v1/memory/spaces/{space}/source_search`"""
        return self._call(_operation("sourceSearch"), body=body, space=space)

    def checkpoint(self, space: str, name: str) -> MemoryCheckpoint:
        """Read a named checkpoint. `GET /v1/memory/spaces/{space}/checkpoints/{name}`"""
        return self._call(_operation("checkpoint"), space=space, name=name)

    def save_checkpoint(self, space: str, name: str, body: SaveCheckpointRequest, *, idempotency_key: Optional[str] = None) -> MemoryReceipt:
        """Save a named checkpoint (compare-and-set on its version). `POST /v1/memory/spaces/{space}/checkpoints/{name}`"""
        return self._call(_operation("saveCheckpoint"), body=body, idempotency_key=idempotency_key, space=space, name=name)

    def capture_checkpoint(self, space: str, name: str, body: MemoryCheckpointCapture, *, idempotency_key: Optional[str] = None) -> MemoryCheckpointCaptureReceipt:
        """Capture sources and the checkpoint naming them in one transaction. `POST /v1/memory/spaces/{space}/checkpoints/{name}/capture`"""
        return self._call(_operation("captureCheckpoint"), body=body, idempotency_key=idempotency_key, space=space, name=name)

    def export_bundle(self, space: str) -> MemoryBundle:
        """Export the space as one bundle. `GET /v1/memory/spaces/{space}/bundle`"""
        return self._call(_operation("exportBundle"), space=space)

    def import_bundle(self, space: str, body: MemoryBundle, *, idempotency_key: Optional[str] = None) -> ImportBundleResponse:
        """Import a bundle into the space. `POST /v1/memory/spaces/{space}/bundle`"""
        return self._call(_operation("importBundle"), body=body, idempotency_key=idempotency_key, space=space)

    def export_transfer_page(self, space: str, *, cursor: Optional[str] = None) -> MemoryTransferPage:
        """Export the space page by page. `GET /v1/memory/spaces/{space}/transfer`"""
        return self._call(_operation("exportTransferPage"), space=space, cursor=cursor)

    def transfers(self, space: str, *, state: Optional[str] = None, limit: Optional[float] = None, cursor: Optional[str] = None) -> MemoryTransferList:
        """Paged imports into this space. `GET /v1/memory/spaces/{space}/transfers`"""
        return self._call(_operation("transfers"), space=space, state=state, limit=limit, cursor=cursor)

    def begin_transfer(self, space: str, body: MemoryTransferHeader, *, idempotency_key: Optional[str] = None) -> MemoryTransferStatus:
        """Begin a paged import. `POST /v1/memory/spaces/{space}/transfers`"""
        return self._call(_operation("beginTransfer"), body=body, idempotency_key=idempotency_key, space=space)

    def transfer_status(self, space: str, id: str) -> MemoryTransferStatus:
        """One paged import. `GET /v1/memory/spaces/{space}/transfers/{id}`"""
        return self._call(_operation("transferStatus"), space=space, id=id)

    def append_transfer(self, space: str, id: str, body: MemoryTransferPage, *, idempotency_key: Optional[str] = None) -> MemoryTransferStatus:
        """Add a page to a paged import. `POST /v1/memory/spaces/{space}/transfers/{id}/pages`"""
        return self._call(_operation("appendTransfer"), body=body, idempotency_key=idempotency_key, space=space, id=id)

    def commit_transfer(self, space: str, id: str, body: CommitTransferRequest, *, idempotency_key: Optional[str] = None) -> CommitTransferResponse:
        """Commit a paged import, checked against its hash. `POST /v1/memory/spaces/{space}/transfers/{id}/commit`"""
        return self._call(_operation("commitTransfer"), body=body, idempotency_key=idempotency_key, space=space, id=id)

    def abort_transfer(self, space: str, id: str, body: AbortTransferRequest, *, idempotency_key: Optional[str] = None) -> MemoryReceipt:
        """Abandon a paged import. `POST /v1/memory/spaces/{space}/transfers/{id}/abort`"""
        return self._call(_operation("abortTransfer"), body=body, idempotency_key=idempotency_key, space=space, id=id)

    def export(self, space: str) -> ExportResponse:
        """Everything in the space as JSON. `GET /v1/memory/spaces/{space}/export`"""
        return self._call(_operation("export"), space=space)

    def job(self, space: str, id: str) -> MemoryJobStatus:
        """An index job (a receipt's job_id). `GET /v1/memory/spaces/{space}/jobs/{id}`"""
        return self._call(_operation("job"), space=space, id=id)

    def json_store(self, space: str, body: JsonStoreRequest, *, idempotency_key: Optional[str] = None) -> JsonStoreResponse:
        """Key-value JSON documents in namespaces, as one atomic batch (1-64 operations). `POST /v1/memory/spaces/{space}/json_store`"""
        return self._call(_operation("jsonStore"), body=body, idempotency_key=idempotency_key, space=space)

    def workflow(self, space: str, body: WorkflowRequest) -> WorkflowResponse:
        """Task workflows over memory: start, run, finish, resume, recipes, watches. `POST /v1/memory/spaces/{space}/workflow`"""
        return self._call(_operation("workflow"), body=body, space=space)

    def assist_create(self, space: str, body: MemoryAssistanceInput, *, idempotency_key: Optional[str] = None) -> AssistCreateResponse:
        """Ask a helper for memory work. `POST /v1/memory/spaces/{space}/assistance`"""
        return self._call(_operation("assistCreate"), body=body, idempotency_key=idempotency_key, space=space)

    def assist_jobs(self, *, open: Optional[bool] = None, limit: Optional[float] = None, cursor: Optional[str] = None) -> MemoryAssistancePage:
        """Assistance jobs for this principal. `GET /v1/memory/assistance`"""
        return self._call(_operation("assistJobs"), open=open, limit=limit, cursor=cursor)

    def assist_get(self, job: str) -> MemoryAssistanceJob:
        """One assistance job. `GET /v1/memory/assistance/{job}`"""
        return self._call(_operation("assistGet"), job=job)

    def assist_claim(self, job: str, body: AssistClaimRequest, *, idempotency_key: Optional[str] = None) -> AssistClaimResponse:
        """Claim a job (as its worker); returns a lease. `POST /v1/memory/assistance/{job}/claim`"""
        return self._call(_operation("assistClaim"), body=body, idempotency_key=idempotency_key, job=job)

    def assist_heartbeat(self, job: str, body: AssistHeartbeatRequest, *, idempotency_key: Optional[str] = None) -> AssistHeartbeatResponse:
        """Extend the lease. `POST /v1/memory/assistance/{job}/heartbeat`"""
        return self._call(_operation("assistHeartbeat"), body=body, idempotency_key=idempotency_key, job=job)

    def assist_read(self, job: str, body: AssistReadRequest, *, idempotency_key: Optional[str] = None) -> AssistReadResponse:
        """Run one read operation inside the job's scope. `POST /v1/memory/assistance/{job}/read`"""
        return self._call(_operation("assistRead"), body=body, idempotency_key=idempotency_key, job=job)

    def assist_finish(self, job: str, body: AssistFinishRequest, *, idempotency_key: Optional[str] = None) -> AssistFinishResponse:
        """Finish with an answer (cited) or an abstention. `POST /v1/memory/assistance/{job}/finish`"""
        return self._call(_operation("assistFinish"), body=body, idempotency_key=idempotency_key, job=job)

    def assist_cancel(self, job: str, body: AssistCancelRequest, *, idempotency_key: Optional[str] = None) -> AssistCancelResponse:
        """Cancel a job. `POST /v1/memory/assistance/{job}/cancel`"""
        return self._call(_operation("assistCancel"), body=body, idempotency_key=idempotency_key, job=job)

    def assist_delegate(self, job: str, body: AssistDelegateRequest, *, idempotency_key: Optional[str] = None) -> AssistDelegateResponse:
        """Hand part of the job to another helper. `POST /v1/memory/assistance/{job}/delegate`"""
        return self._call(_operation("assistDelegate"), body=body, idempotency_key=idempotency_key, job=job)

    def assist_adopt(self, job: str, body: AssistAdoptRequest, *, idempotency_key: Optional[str] = None) -> MemoryAdoptResult:
        """Adopt the job's answer into its own space. `POST /v1/memory/assistance/{job}/adopt`"""
        return self._call(_operation("assistAdopt"), body=body, idempotency_key=idempotency_key, job=job)

class RoutingApi(HttpApi):
    """The routing operations of marina.http.v1, typed. Anything newer: `call(...)`."""

    def __init__(self, base_url: str, token: TokenSource, timeout: float = 35.0) -> None:
        super().__init__(base_url, token, "routing", timeout)

    def discover(self, *, after: Optional[str] = None, limit: Optional[float] = None) -> RoutingSessionPage:
        """Sessions you can see. `GET /api/routing/sessions`"""
        return self._call(_operation("discover"), after=after, limit=limit)

    def join_session(self, body: RoutingJoin) -> RoutingSession:
        """Join as a routed participant session. `POST /api/routing/sessions`"""
        return self._call(_operation("joinSession"), body=body)

    def overview(self, *, after: Optional[str] = None, limit: Optional[float] = None, attention: Optional[bool] = None) -> RoutingOverview:
        """Sessions with their latest activity. `GET /api/routing/overview`"""
        return self._call(_operation("overview"), after=after, limit=limit, attention=attention)

    def session(self, session: str) -> RoutingSession:
        """One session. `GET /api/routing/sessions/{session}`"""
        return self._call(_operation("session"), session=session)

    def heartbeat(self, session: str, body: HeartbeatRequest) -> RoutingSession:
        """Keep the session live. `POST /api/routing/sessions/{session}/heartbeat`"""
        return self._call(_operation("heartbeat"), body=body, session=session)

    def leave(self, session: str, body: LeaveRequest) -> RoutingSession:
        """End the session. `POST /api/routing/sessions/{session}/leave`"""
        return self._call(_operation("leave"), body=body, session=session)

    def events(self, session: str, *, after: Optional[float] = None, limit: Optional[float] = None) -> RoutingEventPage:
        """Events after a cursor (poll this to watch). `GET /api/routing/sessions/{session}/events`"""
        return self._call(_operation("events"), session=session, after=after, limit=limit)

    def publish(self, session: str, body: PublishRequest) -> PublishResponse:
        """Publish output events. `POST /api/routing/sessions/{session}/events`"""
        return self._call(_operation("publish"), body=body, session=session)

    def send(self, session: str, body: RoutingSend) -> RoutingMessage:
        """Send a message to another session. `POST /api/routing/sessions/{session}/messages`"""
        return self._call(_operation("send"), body=body, session=session)

    def inbox(self, session: str, *, limit: Optional[float] = None) -> InboxResponse:
        """Messages waiting for this session. `GET /api/routing/sessions/{session}/inbox`"""
        return self._call(_operation("inbox"), session=session, limit=limit)

    def deliveries(self, session: str, *, limit: Optional[float] = None) -> DeliveriesResponse:
        """Messages this session sent, with delivery state. `GET /api/routing/sessions/{session}/deliveries`"""
        return self._call(_operation("deliveries"), session=session, limit=limit)

    def receipt(self, session: str, message: str) -> RoutingMessage:
        """One message's delivery state. `GET /api/routing/sessions/{session}/messages/{message}`"""
        return self._call(_operation("receipt"), session=session, message=message)

    def acknowledge_message(self, session: str, message: str, body: AcknowledgeMessageRequest) -> RoutingMessage:
        """Acknowledge a received message. `POST /api/routing/sessions/{session}/messages/{message}/ack`"""
        return self._call(_operation("acknowledgeMessage"), body=body, session=session, message=message)

    def channels(self, session: str) -> ChannelsResponse:
        """World channels this session can use. `GET /api/routing/sessions/{session}/channels`"""
        return self._call(_operation("channels"), session=session)

    def channel_messages(self, session: str, channel: str, *, after: Optional[float] = None, limit: Optional[float] = None) -> RoutingChannelPage:
        """Channel history after a cursor. `GET /api/routing/sessions/{session}/channels/{channel}/messages`"""
        return self._call(_operation("channelMessages"), session=session, channel=channel, after=after, limit=limit)

    def send_channel(self, session: str, channel: str, body: SendChannelRequest) -> RoutingChannelReceipt:
        """Post to a channel. `POST /api/routing/sessions/{session}/channels/{channel}/messages`"""
        return self._call(_operation("sendChannel"), body=body, session=session, channel=channel)

    def sync(self, body: RoutingSyncInput) -> RoutingSyncResult:
        """Report a supervisor's runtimes and collect their controls. `POST /api/routing/sync`"""
        return self._call(_operation("sync"), body=body)

    def runtime(self, session: str) -> RuntimeResponse:
        """The session's supervised runtime state. `GET /api/routing/sessions/{session}/runtime`"""
        return self._call(_operation("runtime"), session=session)

    def control(self, session: str, body: ControlRequest) -> RoutingMessage:
        """Send a runtime control (steer, interrupt, stop…) to another session. `POST /api/routing/sessions/{session}/control`"""
        return self._call(_operation("control"), body=body, session=session)

    def enrol_resident(self, body: ResidentEnrolInput) -> ResidentEnrolment:
        """Enrol a run's agent as its own world account. `POST /api/routing/residents`"""
        return self._call(_operation("enrolResident"), body=body)

    def renew_resident(self, name: str, body: RenewResidentRequest) -> RenewResidentResponse:
        """A fresh credential for a live owned run. `POST /api/routing/residents/{name}/renew`"""
        return self._call(_operation("renewResident"), body=body, name=name)

    def revoke_resident(self, name: str, body: RevokeResidentRequest) -> RevokeResidentResponse:
        """End this run's hold on the resident. `POST /api/routing/residents/{name}/revoke`"""
        return self._call(_operation("revokeResident"), body=body, name=name)

    def report_resident_attention(self, name: str, body: ResidentAttentionReport) -> ReportResidentAttentionResponse:
        """Report attention-bridge decisions and presence. `POST /api/routing/residents/{name}/attention`"""
        return self._call(_operation("reportResidentAttention"), body=body, name=name)

    def issue_supervision(self, body: IssueSupervisionRequest) -> SupervisionCredentialGrant:
        """Exchange a world session for a routing-only supervision credential. `POST /api/routing/supervision`"""
        return self._call(_operation("issueSupervision"), body=body)

    def renew_supervision(self, body: RenewSupervisionRequest) -> SupervisionCredentialGrant:
        """Replace the presented supervision credential. `POST /api/routing/supervision/renew`"""
        return self._call(_operation("renewSupervision"), body=body)

    def revoke_supervision(self, body: RevokeSupervisionRequest) -> RevokeSupervisionResponse:
        """Revoke the presented supervision credential. `POST /api/routing/supervision/revoke`"""
        return self._call(_operation("revokeSupervision"), body=body)

class InvestigationsApi(HttpApi):
    """The investigations operations of marina.http.v1, typed. Anything newer: `call(...)`."""

    def __init__(self, base_url: str, token: TokenSource, timeout: float = 35.0) -> None:
        super().__init__(base_url, token, "investigations", timeout)

    def list_investigations(self, *, before: Optional[float] = None) -> ListInvestigationsResponse:
        """Your cases, newest first. `GET /api/investigations`"""
        return self._call(_operation("listInvestigations"), before=before)

    def start_investigation(self, body: StartInvestigationRequest) -> StartInvestigationResponse:
        """Start an investigation (or replay the one this key started). `POST /api/investigations`"""
        return self._call(_operation("startInvestigation"), body=body)

    def get_investigation(self, case: str, *, attempt: Optional[str] = None) -> InvestigationSnapshot:
        """A case with its attempts (or one attempt of it). `GET /api/investigations/{case}`"""
        return self._call(_operation("getInvestigation"), case=case, attempt=attempt)

    def erase_investigation(self, case: str) -> EraseInvestigationResponse:
        """Erase a case. `DELETE /api/investigations/{case}`"""
        return self._call(_operation("eraseInvestigation"), case=case)

    def grant_investigation(self, case: str, body: GrantInvestigationRequest) -> GrantInvestigationResponse:
        """Share a case (null access removes it). `POST /api/investigations/{case}/grants`"""
        return self._call(_operation("grantInvestigation"), body=body, case=case)

    def attempt(self, attempt: str) -> InvestigationAttempt:
        """One attempt. `GET /api/investigations/attempts/{attempt}`"""
        return self._call(_operation("attempt"), attempt=attempt)

    def attempt_events(self, attempt: str, *, after: Optional[float] = None, limit: Optional[float] = None) -> InvestigationEventPage:
        """An attempt's events after a cursor. `GET /api/investigations/attempts/{attempt}/events`"""
        return self._call(_operation("attemptEvents"), attempt=attempt, after=after, limit=limit)

    def cancel_attempt(self, attempt: str, body: CancelAttemptRequest) -> CancelAttemptResponse:
        """Cancel an attempt. `POST /api/investigations/attempts/{attempt}/cancel`"""
        return self._call(_operation("cancelAttempt"), body=body, attempt=attempt)

    def select_attempt(self, attempt: str, body: SelectAttemptRequest) -> InvestigationSnapshot:
        """Make this attempt the case's answer. `POST /api/investigations/attempts/{attempt}/select`"""
        return self._call(_operation("selectAttempt"), body=body, attempt=attempt)

    def review_attempt(self, attempt: str, body: ReviewAttemptRequest) -> InvestigationEvent:
        """Add a review note. `POST /api/investigations/attempts/{attempt}/review`"""
        return self._call(_operation("reviewAttempt"), body=body, attempt=attempt)

    def resolve_attempt(self, attempt: str, body: ResolveAttemptRequest) -> ResolveAttemptResponse:
        """Record the real outcome; scores a prediction. `POST /api/investigations/attempts/{attempt}/resolve`"""
        return self._call(_operation("resolveAttempt"), body=body, attempt=attempt)

    def investigation_content(self, content: str) -> InvestigationContent:
        """Stored content an event refers to. `GET /api/investigations/content/{content}`"""
        return self._call(_operation("investigationContent"), content=content)

class PanelsApi(HttpApi):
    """The panels operations of marina.http.v1, typed. Anything newer: `call(...)`."""

    def __init__(self, base_url: str, token: TokenSource, timeout: float = 35.0) -> None:
        super().__init__(base_url, token, "panels", timeout)

    def canvases(self, *, limit: Optional[float] = None) -> CanvasesResponse:
        """Canvases you can see. `GET /api/canvases`"""
        return self._call(_operation("canvases"), limit=limit)

    def create_canvas(self, body: CreateCanvasRequest) -> CreateCanvasResponse:
        """Create a canvas to publish panels on. `POST /api/canvases`"""
        return self._call(_operation("createCanvas"), body=body)

    def panel_resources(self) -> PanelResourcesResponse:
        """Live data a panel can bind to. `GET /api/panel-resources`"""
        return self._call(_operation("panelResources"))

    def canvas(self, canvas: str) -> CanvasResponse:
        """A canvas with its nodes (panels are type `a2ui`). `GET /api/canvases/{canvas}`"""
        return self._call(_operation("canvas"), canvas=canvas)

    def publish_panel(self, canvas: str, body: PublishPanelRequest) -> PublishedPanelNode:
        """Publish a panel. `POST /api/canvases/{canvas}/nodes`"""
        return self._call(_operation("publishPanel"), body=body, canvas=canvas)

    def panel(self, canvas: str, node: str) -> PublishedPanelNode:
        """One panel. `GET /api/canvases/{canvas}/nodes/{node}`"""
        return self._call(_operation("panel"), canvas=canvas, node=node)

    def revise_panel(self, canvas: str, node: str, body: RevisePanelRequest) -> PublishedPanelNode:
        """Replace a panel's document (409 if `revision` is stale). `PATCH /api/canvases/{canvas}/nodes/{node}`"""
        return self._call(_operation("revisePanel"), body=body, canvas=canvas, node=node)

    def interact_panel(self, canvas: str, node: str, body: PanelInteractionInput) -> InteractPanelResponse:
        """Press a panel's button or submit its form. `POST /api/canvases/{canvas}/nodes/{node}/interaction`"""
        return self._call(_operation("interactPanel"), body=body, canvas=canvas, node=node)
