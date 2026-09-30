# SDK API reference

Generated from the TypeScript compiler's published declarations by `bun run docs:api`.

Entry points: `@marina/agent-sdk`, `@marina/agent-sdk/memory`, `@marina/agent-sdk/routing`.
Only declarations reachable from these entry points are included. Private implementation
bodies are omitted by the compiler. This reference includes request/response types, method
signatures and their source documentation. Use the package exports rather than importing
individual declaration modules as undocumented package subpaths.

See [HTTP dispatch](http.md), [MCP tools](mcp.md), [builtin commands](commands.md),
and the [SDK quickstart](../../src/sdk/README.md).

## capabilities

[Source](../../src/sdk/capabilities.ts)

```typescript
import type { CommandForm } from "./command-forms.js";
export interface CommandCatalogEntry {
    forms?: CommandForm[];
    /** Stable named MCP payloads, separate from executable command-line forms. */
    namedTools?: CommandForm[];
    description?: string;
    owner?: string;
    revision?: number;
    scope?: "world" | "room";
    structured?: boolean;
    availability?: {
        status: "available" | "conditional" | "unavailable";
        reasons: string[];
    };
    name: string;
    aliases: string[];
    category: string;
    help: string;
    minRank: number;
    gate?: string;
}
export interface CapabilityManifest {
    schema: "marina.capabilities.v1";
    revision: number;
    key?: string;
    commands: CommandCatalogEntry[];
    request_id?: string;
}
/** Byte bounded, live roster. Selection is command ids, never separately maintained prose. */
export declare function renderCapabilityRoster(entries: CommandCatalogEntry[], maxBytes?: number): string;
```

## client

[Source](../../src/sdk/client.ts)

```typescript
import type { CapabilityManifest } from "./capabilities.js";
import { type CodingCommandTarget } from "./command-target.js";
import { type RunScoreDeps } from "./conduct.js";
import type { UnifiedContextResult } from "./memory-context.js";
import type { MemoryOperationRequest, MemoryOperationResult } from "./memory-operations.js";
import type { EntityId, Perception, RoomId } from "./protocol.js";
import type { Score } from "./score.js";
import type { ScoreRun } from "./score-executor.js";
export type { Perception };
export interface SessionInfo {
    entityId: EntityId;
    token: string;
    name: string;
    activeEvolutionSessions?: Array<{
        id: number;
        experimentId: number;
    }>;
}
export interface RoomView {
    id: RoomId;
    short: string;
    long: string;
    items: Record<string, string>;
    exits: string[];
    entities: {
        id: EntityId;
        name: string;
        short: string;
    }[];
}
export interface ClientOptions {
    autoReconnect?: boolean;
    reconnectDelay?: number;
    /** Ping keepalive interval in ms (default: 30000, 0 to disable) */
    pingInterval?: number;
    /** Connection timeout in ms (default: 30000) */
    connectTimeout?: number;
    /** Max reconnect attempts before giving up (default: 10) */
    maxReconnectAttempts?: number;
    /** Max delay between reconnect attempts in ms (default: 30000) */
    maxReconnectDelay?: number;
    /** Quiet interval for legacy servers only (default: 500). Silence is not completion. */
    commandDrainTimeout?: number;
    /** Auto negotiates legacy compatibility; correlated refuses legacy commands before sending. */
    commandMode?: "auto" | "correlated";
    /** World grammar ignores a resident's human input modal. Native tool clients
     * should select world; requires advertised support, never silently downgrades. */
    commandGrammar?: "modal" | "world";
    /** Command completion timeout in ms (default: 120000). A timeout never implies success. */
    commandTimeout?: number;
    /** Callback fired immediately after WebSocket opens, before any login message is sent. */
    onOpen?: (ws: WebSocket) => void;
    /** Internal-agent token. Sent with login/auth messages so the engine can
     * exempt internal room/crew agents from instance login limits. */
    internalToken?: string;
}
export interface CommandOptions {
    signal?: AbortSignal;
    codingTarget?: CodingCommandTarget;
}
type PerceptionHandler = (p: Perception) => void;
/** Legacy results are observations, without guaranteed attribution or completion. */
export type CommandResult = Perception[] & {
    readonly completion: "confirmed" | "unconfirmed";
};
export declare class CommandError extends Error {
    readonly perceptions: Perception[];
    constructor(message: string, perceptions?: Perception[]);
}
export type ClientEventMap = {
    connect: [SessionInfo];
    disconnect: [];
    perception: [Perception];
    error: [Error];
    reconnect_failed: [];
};
type ClientEventName = keyof ClientEventMap;
/**
 * Prefix for `tell`s that are lifecycle notices rather than conversational
 * replies ("I paused", "budget spent"). `tellAndAwait` never treats a tell
 * starting with this prefix as the answer to a question. Emitters (the
 * lean-agent adapter's `notifySpawner`) should adopt it; until they do,
 * `TELL_NOTICE_PATTERNS` matches the notices they emit today by stable prefix.
 */
export declare const TELL_NOTICE_PREFIX = "[notice]";
/**
 * Stable prefixes of the spawner notices `LeanAgentAdapter.notifySpawner`
 * emits today (model-call budget exhausted, spend cap reached, upstream-error
 * pause). Kept deliberately narrow — a false positive here would swallow a
 * real reply, which is worse than letting a notice through.
 */
export declare const TELL_NOTICE_PATTERNS: readonly RegExp[];
/** True when `text` is a known system notice rather than a reply. */
export declare function isTellNotice(text: string): boolean;
/** Default grace after the first untagged candidate during which a tagged reply still wins. */
export declare const TELL_AWAIT_GRACE_MS = 1500;
/** Six-char base-36 id for a `[re:<id>]` correlation tag. */
export declare function newCorrelationId(): string;
/** The tag appended to an outgoing correlated tell: ` [re:<id>]`. */
export declare function correlationTag(id: string): string;
/** True when `text` carries `re:<id>` (bracketed or bare). */
export declare function hasCorrelationTag(text: string, id: string): boolean;
/** Remove every `[re:<id>]` / `re:<id>` occurrence and trim. */
export declare function stripCorrelationTag(text: string, id: string): string;
export interface TellAndAwaitOptions {
    signal?: AbortSignal;
    /** Observe the correlated send receipt (distinct from the peer's reply). */
    onDelivered?: (perceptions: Perception[]) => void;
    /** Refuse untagged replies; required to isolate concurrent machine requests. */
    strictCorrelation?: boolean;
    /**
     * Append a ` [re:<6-char id>]` tag to the outgoing message and prefer a reply
     * that echoes it. Default true. Responders that do not echo the tag still
     * work: the first fresh, non-notice tell from the target is accepted after
     * `graceMs`.
     */
    correlate?: boolean;
    /**
     * How long to hold an untagged candidate reply open for a tagged one to
     * arrive before accepting the candidate (default `TELL_AWAIT_GRACE_MS`).
     * Only meaningful when `correlate` is true.
     */
    graceMs?: number;
    /** Ignore replies that match `isTellNotice` (default true). */
    ignoreNotices?: boolean;
}
export declare class MarinaClient {
    private ws;
    private url;
    private options;
    private session;
    private handlers;
    private connected;
    private pingTimer;
    private reconnectTimer;
    private reconnectAttempts;
    private commandProtocol;
    private codingTargetSupported;
    private worldCommandSupported;
    private commandSession;
    private legacyCommands;
    private legacyCommandUncertain;
    private eventListeners;
    constructor(url: string, options?: ClientOptions);
    /** Check if connected to the server. */
    isConnected(): boolean;
    /** Get the server URL. */
    getUrl(): string;
    /** Negotiated when login/auth succeeds; no commands are replayed to detect support. */
    getCommandProtocol(): "correlated" | "legacy" | undefined;
    private negotiateCommands;
    private worldCommand;
    /** Subscribe to a client event. */
    on<K extends ClientEventName>(event: K, handler: (...args: ClientEventMap[K]) => void): void;
    /** Unsubscribe from a client event. */
    off<K extends ClientEventName>(event: K, handler: (...args: ClientEventMap[K]) => void): void;
    private emit;
    /** Connect and login with a character name. */
    connect(name: string): Promise<SessionInfo>;
    /** Reconnect using a previously issued session token. */
    reconnect(token: string): Promise<SessionInfo>;
    /** Confirmed results on current servers; explicitly unconfirmed observations on legacy servers. */
    command(cmd: string, options?: AbortSignal | CommandOptions): Promise<CommandResult>;
    private legacyCommand;
    private collectLegacyCommand;
    private capabilityCache?;
    /** Query the authenticated live command registry, including room overrides. */
    capabilities(timeoutMs?: number): Promise<CapabilityManifest>;
    contextPreview(query: string, budgetBytes?: number, signal?: AbortSignal): Promise<{
        context: UnifiedContextResult;
        createdAt: number;
    }>;
    /** Correlated service reply; independent of the short command perception-drain window. */
    memoryService(request: MemoryOperationRequest, timeoutMs?: number, signal?: AbortSignal): Promise<MemoryOperationResult>;
    /** Subscribe to all incoming perceptions. */
    onPerception(handler: PerceptionHandler): void;
    /** Remove a perception handler. */
    offPerception(handler: PerceptionHandler): void;
    /** Get current session info. */
    getSession(): SessionInfo | null;
    /** Disconnect from the server gracefully.
     *
     * This is a TRANSIENT close: the server keeps the entity alive for its
     * reconnect grace window so a token-bearing reconnect (e.g. back-to-back
     * CLI one-shots) rebinds the SAME entity — same id, same properties, same
     * quest state. Sending `quit` here (the pre-fix behavior) told the server
     * "I'm done, remove me", which hard-deleted the entity and reset all
     * property state between invocations. Use `quit()` for explicit teardown. */
    disconnect(): void;
    private internalHandlers;
    private addInternalHandler;
    private removeInternalHandler;
    private ensureWebSocket;
    private scheduleReconnect;
    private dispatchPerception;
    private send;
    private startPing;
    private stopPing;
    /**
     * Send a `tell` to `target` and synchronously wait for its reply —
     * eliminates the multi-tick handoff that normally separates a
     * coordinator's ask from a specialist's answer.
     *
     * Crew-fast-dispatch primitive (see the crew fast-dispatch design (private archive: marina-internal design/crew-fast-dispatch-design.md)):
     * by registering the perception listener BEFORE firing the command we
     * avoid the race where the reply arrives before the listener is armed.
     * The caller's LLM turn is held open inside this single tool call so
     * the round-trip pays one continuation-prompt cost instead of two.
     *
     * Which tell counts as THE reply (all three guards are needed — without
     * them a late answer to a previous question or a lifecycle notice was
     * returned as the answer):
     *   1. Freshness. The engine emits our own `You tell …` echo in the same
     *      synchronous block that delivers the message to `target`, and one
     *      WebSocket connection delivers perceptions in order, so any tell
     *      from the target that arrives BEFORE that echo predates our
     *      question (a queued stale frame) and is ignored — independent of
     *      clock skew. Until the echo is seen, a tell is also rejected when
     *      its server timestamp is older than our local send time.
     *   2. Notice filter. Tells matching `isTellNotice` (budget exhausted,
     *      spend cap, upstream-error pause, or anything prefixed with
     *      `TELL_NOTICE_PREFIX`) are never an answer.
     *   3. Correlation. With `correlate` (default) the outgoing message gets
     *      a ` [re:<id>]` tag; a reply echoing `re:<id>` wins immediately.
     *      An untagged fresh reply is held for `graceMs` in case a tagged one
     *      follows, then accepted — so responders that don't echo the tag
     *      still work. The tag is stripped from the returned text.
     *
     * Resolves with the reply message text. Rejects with an explanatory
     * Error on timeout (a buffered untagged candidate is returned instead of
     * rejecting). Failure modes the caller may want to handle:
     *   - target offline: no perception will match; caller times out
     *   - target ignored you: same as offline
     *   - target replies with multiple tells: only the first accepted is consumed
     */
    tellAndAwait(target: string, message: string, timeoutMs?: number, opts?: TellAndAwaitOptions): Promise<string>;
}
export declare class MarinaAgent extends MarinaClient {
    /** Look at the current room or a specific target. */
    look(target?: string): Promise<RoomView | Perception[]>;
    /** Move in a direction. */
    move(direction: string): Promise<Perception[]>;
    /** Say something to the room. */
    say(message: string): Promise<void>;
    /** Send a private message. */
    tell(target: string, message: string): Promise<void>;
    /** Send a message to a channel. */
    channel(name: string, message: string): Promise<void>;
    /** Get list of online entities. */
    who(): Promise<Perception[]>;
    /** Get help. */
    help(command?: string): Promise<Perception[]>;
    /** Check inventory. */
    inventory(): Promise<Perception[]>;
    /** Take a note anchored to the current room. */
    think(action: "note" | "recall" | "reflect", text: string, opts?: {
        importance?: number;
        type?: string;
        modifier?: "recent" | "important";
    }): Promise<Perception[]>;
    /** Context-aware guidance — what to do next. */
    next(): Promise<Perception[]>;
    /** World orientation signal. */
    brief(mode?: "compass" | "full"): Promise<Perception[]>;
    /** Quest operations. */
    quest(action?: string, name?: string): Promise<Perception[]>;
    /** Examine a target. */
    examine(target: string): Promise<Perception[]>;
    /** Board operations. */
    board(sub: string, ...args: string[]): Promise<Perception[]>;
    /** Task operations. */
    task(sub: string, ...args: string[]): Promise<Perception[]>;
    /** Group operations. */
    group(sub: string, ...args: string[]): Promise<Perception[]>;
    /** Macro operations. */
    macro(sub: string, ...args: string[]): Promise<Perception[]>;
    /** Global search. */
    search(query: string): Promise<Perception[]>;
    /** Save a note (tagged with current room). */
    note(text: string): Promise<Perception[]>;
    /** List all personal notes. */
    notes(): Promise<Perception[]>;
    /** Experiment operations. */
    experiment(sub: string, ...args: string[]): Promise<Perception[]>;
    /** Bookmark current room or manage bookmarks. */
    bookmark(sub?: string, ...args: string[]): Promise<Perception[]>;
    /** Export a board's posts. */
    exportBoard(name: string, format?: string): Promise<Perception[]>;
    /** Create a task bundle (parent container). */
    taskBundle(title: string, description?: string): Promise<Perception[]>;
    /** Assign a task to a bundle. */
    taskAssign(taskId: number, bundleId: number): Promise<Perception[]>;
    /** List children of a task bundle. */
    taskChildren(bundleId: number): Promise<Perception[]>;
    /** Vote on a board post with optional numeric score (1-10). */
    boardScore(postId: number, direction: string, score?: number): Promise<Perception[]>;
    /** Get score breakdown for a board post. */
    boardScores(postId: number): Promise<Perception[]>;
    /** Core memory operations. */
    memory(sub: string, ...args: string[]): Promise<Perception[]>;
    /** Scored note retrieval. */
    recall(query: string, mode?: "recent" | "important"): Promise<Perception[]>;
    /** Create a reflection from recent notes. */
    reflect(topic?: string): Promise<Perception[]>;
    /** Note with importance and type. */
    typedNote(text: string, importance?: number, type?: string): Promise<Perception[]>;
    /** Link two notes. */
    noteLink(id1: number, id2: number, rel: string): Promise<Perception[]>;
    /** Correct a note. */
    noteCorrect(id: number, newText: string): Promise<Perception[]>;
    /** Trace note graph. */
    noteTrace(id: number): Promise<Perception[]>;
    /** Shared memory pool operations. */
    pool(sub: string, ...args: string[]): Promise<Perception[]>;
    /**
     * Run a Score live — dispatch each step to its worker via tellAndAwait and
     * thread accessed outputs forward. This is the act of conducting: a Score
     * becomes a running organization. Supply `resolveAssignee` to map role:/model:
     * assignees to concrete agents. See src/sdk/conduct.ts.
     */
    conduct(score: Score, opts?: Omit<RunScoreDeps, "tellAndAwait">): Promise<ScoreRun>;
    /** Upload an asset from a URL. Returns the asset upload response. */
    uploadAsset(url: string): Promise<Perception[]>;
    /** List uploaded assets. */
    listAssets(): Promise<Perception[]>;
    /** Delete an asset by ID. */
    deleteAsset(assetId: string): Promise<Perception[]>;
    /** Create a new canvas. */
    createCanvas(name: string, description?: string): Promise<Perception[]>;
    /** List all canvases. */
    listCanvases(): Promise<Perception[]>;
    /** Publish an asset to a canvas as a typed node. */
    publishToCanvas(type: string, assetId: string, canvas?: string): Promise<Perception[]>;
    /** Get canvas info including nodes. */
    canvasInfo(name: string): Promise<Perception[]>;
    /** List nodes on a canvas. */
    canvasNodes(name: string): Promise<Perception[]>;
    /** Delete a canvas. */
    deleteCanvas(name: string): Promise<Perception[]>;
    /** Run a shell command. */
    run(cmd: string): Promise<Perception[]>;
    /** Run a shell command quietly (suppress output). */
    runQuiet(cmd: string): Promise<Perception[]>;
    /** Shell management operations. */
    shell(sub: string, ...args: string[]): Promise<Perception[]>;
    /** Execute multiple commands in sequence. */
    batch(...commands: string[]): Promise<Perception[]>;
    /**
     * Wait for the next incoming perception matching a predicate.
     * Rejects after `timeoutMs` (default 30 seconds).
     */
    waitForMessage(predicate: (p: Perception) => boolean, timeoutMs?: number): Promise<Perception>;
    /**
     * Wait for a `tell` (private message) from any sender (or a specific sender).
     * Returns the text of the message.
     */
    waitForTell(from?: string, timeoutMs?: number): Promise<string>;
    /** Gracefully quit and disconnect. */
    quit(): Promise<void>;
}
```

## command-forms

[Source](../../src/sdk/command-forms.ts)

```typescript
export interface CommandField {
    id: string;
    label: string;
    placeholder: string;
    optionalGroup?: string;
    kind: "text" | "number" | "json" | "choice";
    choices?: string[];
    multiline: boolean;
    allowNewlines: boolean;
    min?: number;
    max?: number;
    integer?: boolean;
    /** Typed named-tool payloads; ordinary command forms keep text/JSON text. */
    wireType?: "string-array" | "string-record";
    default?: string;
}
interface Part {
    literal?: string;
    field?: string;
    group?: string;
    children?: Part[];
}
export interface CommandForm {
    encoding?: "command" | "named";
    /** Input for MCP invoke and any client that consumes JSON Schema. */
    inputSchema?: Record<string, unknown>;
    effect?: "read" | "write" | "delete" | "execute" | "unknown";
    description?: string;
    examples?: string[];
    syntax: string;
    label: string;
    fields: CommandField[];
    groups: Array<{
        id: string;
        label: string;
        parent?: string;
    }>;
    parts: Part[];
}
/** Turn the platform's documented grammar into fields, optional groups and selectors. */
export declare function parseCommandForm(syntax: string): CommandForm;
/** Compile the grammar declared beside a command; clients receive these descriptors. */
export type CommandUsage = string | {
    syntax: string;
    description?: string;
    effect?: "read" | "write" | "delete" | "execute" | "unknown";
    examples?: string[];
    fields?: Record<string, Partial<CommandField>>;
};
export declare function compileCommandForms(usage: readonly CommandUsage[]): CommandForm[];
/** Literal command/action prefix, stopping before any value or optional group. */
export declare function commandFormPrefix(form: CommandForm): string;
/** Prefer the typed action, then its least restrictive complete form. */
export declare function matchCommandForm(forms: CommandForm[], input: string): CommandForm | undefined;
export declare function composeCommand(form: CommandForm, values: Record<string, string>, enabled: Record<string, boolean>): {
    command: string;
    errors: Record<string, string>;
};
export {};
```

## command-schema

[Source](../../src/sdk/command-schema.ts)

```typescript
import type { CommandField, CommandForm } from "./command-forms.js";
/** One portable field contract for structured commands and stable named tools. */
export declare function commandFieldSchema(field: CommandField): Record<string, unknown>;
export declare function namedInputSchema(form: CommandForm): Record<string, unknown>;
/** Portable invocation schema generated from the same fields the human builder uses. */
export declare function commandInputSchema(form: CommandForm): Record<string, unknown>;
```

## command-target

[Source](../../src/sdk/command-target.ts)

```typescript
/** Request-local destination; never changes the resident's selected coding session. */
export interface CodingCommandTarget {
    readonly sessionId: string;
    /** Optional precondition: this must still be the session's active attempt at execution. */
    readonly runId?: string;
}
/** Shared wire validation. Session ownership and attempt freshness are checked by the engine. */
export declare function parseCodingCommandTarget(value: unknown): CodingCommandTarget;
```

## conduct

[Source](../../src/sdk/conduct.ts)

```typescript
/**
 * Live execution of a Score over the agent transport.
 *
 * Wires the transport-free executor (src/coordination/score-executor.ts) to a
 * real worker-dispatch primitive: `tellAndAwait`. An organizer agent (or an
 * external SDK script) hands each step's instruction — plus the outputs of the
 * steps it accesses — to the resolved worker and awaits the reply. This is the
 * concrete realization of the Conductor: a Score becomes a running organization.
 *
 * Kept separate from client.ts so the dispatch wiring is unit-testable with a
 * fake `tellAndAwait`. See the conductor design (private archive: marina-internal design/conductor-design.md), Phase 4.
 */
import type { TellAndAwaitOptions } from "./client.js";
import type { ParsedAssignee, Score } from "./score.js";
import { type DispatchContext, type ScoreRun, type ScoreStepEvent } from "./score-executor.js";
export interface RunScoreDeps {
    /** Dispatch one worker request and await its reply (one round trip). */
    tellAndAwait: (target: string, message: string, timeoutMs?: number, options?: TellAndAwaitOptions) => Promise<string>;
    /**
     * Resolve a `role:`/`model:` assignee to a concrete target name. Entity
     * assignees resolve to their value automatically. Return null to fall back to
     * the default (which errors for unresolved `role:`).
     */
    resolveAssignee?: (a: ParsedAssignee) => string | null;
    /** Per-step reply timeout, forwarded to tellAndAwait. */
    timeoutMs?: number;
    /** Recursion cap for conduct steps. */
    maxDepth?: number;
    onStep?: (ev: ScoreStepEvent) => void;
    signal?: AbortSignal;
    concurrency?: number;
    runTimeoutMs?: number;
    /** Require exact reply tags for machine workflows (opt-in; preserves legacy replies). */
    strictCorrelation?: boolean;
}
/** Compose the message handed to a worker: instruction + threaded inputs. */
export declare function composeStepMessage(ctx: DispatchContext): string;
/**
 * Run a Score live, dispatching each step via `tellAndAwait`. `conduct` steps
 * have no handler here, so they surface the executor's clear error — recursive
 * sub-Score synthesis is a separate capability.
 */
export declare function runScore(score: Score, deps: RunScoreDeps): Promise<ScoreRun>;
```

## extensions

[Source](../../src/sdk/extensions.ts)

```typescript
import type { CommandUsage } from "./command-forms.js";
import type { DurableMemoryAPI } from "./memory-operations.js";
import type { EntityId, EntityRank, RoomId } from "./protocol.js";
export declare const EXTENSION_API_VERSION = 1;
export interface ExtensionCommandContext {
    readonly caller: Readonly<{
        id: EntityId;
        name: string;
        rank: number;
    }>;
    readonly room: RoomId;
    /** Canonical records, scoped to the current caller and service ACLs. */
    readonly durableMemory: DurableMemoryAPI;
    reply(text: string): void;
}
export interface ExtensionCommand {
    name: string;
    aliases?: string[];
    help: string;
    usage?: CommandUsage[];
    category?: string;
    minRank: EntityRank;
    gate?: string;
    run(context: ExtensionCommandContext, args: string): void | Promise<void>;
}
export interface ExtensionWidget {
    id: string;
    title: string;
    slot: "sidebar" | "admin-tab";
    source: "readiness" | "world";
}
export interface ExtensionResolver {
    kind: string;
    description: string;
    parseArgs(raw: Record<string, string>): {
        ok: true;
        args: unknown;
    } | {
        ok: false;
        error: string;
    };
    idFromArgs(args: unknown): string;
    closesOn: ("resolved" | "changed" | "no-change" | "error")[];
    resolve(input: {
        args: unknown;
        previousSample?: unknown;
    }): Promise<{
        status: "resolved" | "changed";
        value: unknown;
        source: string;
        rawHash?: string;
    } | {
        status: "no-change";
        source: string;
    } | {
        status: "error";
        reason: string;
        retryAfter?: number;
    }>;
}
/** Trusted operator-installed modules. The API limits coupling, not host-code privileges. */
export interface ExtensionContext {
    readonly apiVersion: 1;
    readonly signal: AbortSignal;
    registerCommand(command: ExtensionCommand): void;
    registerResolver(resolver: ExtensionResolver): void;
    registerWidget(widget: ExtensionWidget): void;
}
export interface MarinaExtension {
    activate(context: ExtensionContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}
```

## index

[Source](../../src/sdk/index.ts)

```typescript
export type { CapabilityManifest, CommandCatalogEntry } from "./capabilities.js";
export { renderCapabilityRoster } from "./capabilities.js";
export type { ClientOptions, CommandOptions, CommandResult, RoomView, SessionInfo } from "./client.js";
export { CommandError, MarinaAgent, MarinaClient } from "./client.js";
export type { CommandField, CommandForm, CommandUsage } from "./command-forms.js";
export { commandFormPrefix, compileCommandForms, composeCommand, matchCommandForm, } from "./command-forms.js";
export { commandInputSchema } from "./command-schema.js";
export type { CodingCommandTarget } from "./command-target.js";
export type * from "./extensions.js";
export { EXTENSION_API_VERSION } from "./extensions.js";
export type { UnifiedContextResult } from "./memory-context.js";
export type { DurableMemoryAPI, MemoryOperationRequest } from "./memory-operations.js";
export type { ParticipantOrientation } from "./onboarding.js";
export type { BroadcastPerception, Entity, EntityId, EntityKind, EntityRank, ErrorPerception, MessagePerception, MovementPerception, Perception, PerceptionKind, RoomId, RoomPerception, SystemPerception, } from "./protocol.js";
export type { RoutingClientOptions } from "./routing-client.js";
export { MarinaRoutingClient, RoutingApiError } from "./routing-client.js";
export type * from "./routing-types.js";
```

## memory

[Source](../../src/sdk/memory.ts)

```typescript
export { type MemoryExportFormat, translateMemoryExport } from "./memory-adapters.js";
export type { MemoryAnswer, MemoryAnswerContract, MemoryAnswerSchema, MemoryCitation, MemoryEvidence, } from "./memory-answer.js";
export { assertMemoryAnswerContract, collectMemoryEvidence, createMemoryCitation, validateMemoryAnswer, } from "./memory-answer.js";
export type { MemoryAssistanceInput, MemoryAssistanceJob, MemoryAssistanceListInput, MemoryAssistancePage, MemoryHelperRole, } from "./memory-assistance.js";
export { MEMORY_ASSISTANCE_CONTRACT, MEMORY_ASSISTANCE_READS, MEMORY_HELPER_INSTRUCTIONS, MEMORY_HELPER_ROLES, } from "./memory-assistance.js";
export { MarinaMemoryAssistance } from "./memory-assistance-client.js";
/** Portable public SDK: fetch and Web APIs only; no Bun, SQLite or model imports. */
export { MarinaMemoryClient, MemoryClientError } from "./memory-client.js";
export type { MemoryExpansionCoverage, MemoryQueryExpansion, MemoryQueryVocabulary, } from "./memory-expansion.js";
export { expandMemoryQuery, normalizeMemoryExpansion } from "./memory-expansion.js";
export type { MemoryGraphAction, MemoryGraphEntity, MemoryGraphInputs, MemoryGraphRelation, MemoryGraphResults, MemoryKnowledgeGraph, } from "./memory-knowledge-graph.js";
export { MEMORY_GRAPH_ACTIONS } from "./memory-knowledge-graph.js";
export type { DurableMemoryAPI, MemoryOperationRequest, MemoryOperationResult, } from "./memory-operations.js";
export { MEMORY_OPERATIONS, runMemoryOperation } from "./memory-operations.js";
export { canonicalPortableMemory, memoryPortableDigest } from "./memory-portable.js";
export type { MemoryRecipe, MemoryRetrievalObservation, MemorySelection } from "./memory-recipes.js";
export { compareMemoryRecipes, selectMemoryEvidence } from "./memory-recipes.js";
export { retryMemoryOperation } from "./memory-retry.js";
export type * from "./memory-symbolic.js";
export type { MemoryTaskMessage, MemoryTaskOptions, MemoryTaskResult } from "./memory-task.js";
export { runMemoryTask } from "./memory-task.js";
export type { MemoryTransferFilter, MemoryTransferFragment, MemoryTransferHeader, MemoryTransferKind, MemoryTransferList, MemoryTransferPage, MemoryTransferStatus, } from "./memory-transfer.js";
export { resumeMemoryTransfer } from "./memory-transfer-client.js";
export type * from "./memory-types.js";
export type * from "./memory-workflows.js";
export { MarinaMemoryWorkflows, MEMORY_WORKFLOW_ACTIONS } from "./memory-workflows.js";
```

## memory-adapters

[Source](../../src/sdk/memory-adapters.ts)

```typescript
import type { MemoryClaim } from "./memory-types.js";
export type MemoryExportFormat = "mcp-knowledge-graph-v1" | "langgraph-items-v1";
/** Named import translations, not claims of full third-party API emulation.
 * Original exports remain verbatim sources. No automatic extraction or embedding. */
export declare function translateMemoryExport(format: MemoryExportFormat, raw: unknown, options: {
    origin: string;
    imported_at: number;
}): Promise<{
    bundle: {
        schema: string;
        sha256: string;
        payload: {
            origin_space: string;
            sources: {
                id: string;
                space_id: string;
                seq: number;
                session_id: MemoryExportFormat;
                body: unknown;
                content_hash: string;
                body_sha256: string;
                created_at: number;
            }[];
            records: {
                id: string;
                version: number;
                created_at: number;
                stale: number;
                stale_reason: null;
                versions: {
                    record: {
                        subject: string | null;
                        metadata: {
                            origin: string;
                            created_at_semantics: string;
                        };
                        source_ids: string[];
                        depends_on: never[];
                        dependency_versions: {};
                        claim: MemoryClaim | null;
                        valid_time: null;
                        vocabulary_version: number;
                        id: string;
                        space_id: string;
                        version: number;
                        content: string;
                        type: string;
                        tier: string;
                        importance: number;
                        created_at: number;
                    };
                    attributes: {
                        subject: string | null;
                        metadata: {
                            origin: string;
                            created_at_semantics: string;
                        };
                        source_ids: string[];
                        depends_on: never[];
                        dependency_versions: {};
                        claim: MemoryClaim | null;
                        valid_time: null;
                        vocabulary_version: number;
                    };
                }[];
            }[];
            vocabularies: never[];
            checkpoints: never[];
        };
        excluded: string[];
    };
    format: MemoryExportFormat;
    losses: string[];
    original_source_id: string;
}>;
```

## memory-answer

[Source](../../src/sdk/memory-answer.ts)

```typescript
/** Deliberately bounded JSON Schema subset. Unsupported keywords are errors,
 * never silently ignored. No coercion, inferred facts or model dependency. */
export type MemoryAnswerSchema = {
    type: "string" | "number" | "integer" | "boolean" | "null";
    description?: string;
} | {
    type: "array";
    items: MemoryAnswerSchema;
    description?: string;
} | {
    type: "object";
    properties: Record<string, MemoryAnswerSchema>;
    required: string[];
    additionalProperties: false;
    description?: string;
};
export interface MemoryAnswerContract {
    schema: MemoryAnswerSchema;
    evidence: "required" | "optional";
    allow_historical?: boolean;
}
export type MemoryEvidence = {
    kind: "record";
    space_id: string;
    id: string;
    version: number;
    text: string;
    freshness: string;
} | {
    kind: "source";
    space_id: string;
    id: string;
    text_hash: string;
    start: number;
    end: number;
    text: string;
};
export type MemoryCitation = (Omit<Extract<MemoryEvidence, {
    kind: "record";
}>, "text" | "freshness"> & {
    quote: string;
}) | (Omit<Extract<MemoryEvidence, {
    kind: "source";
}>, "text"> & {
    quote: string;
});
export type MemoryAnswer = {
    status: "answered";
    answer: unknown;
    citations: MemoryCitation[];
} | {
    status: "abstained";
    reason: string;
};
export declare function assertMemoryAnswerContract(contract: MemoryAnswerContract): void;
/** Call only with authenticated read-operation results, not model output or
 * arbitrary documents. Excerpts, provenance IDs and write receipts aren't reads.
 * Source ranges inherit the explicitly requested space; federated callers must
 * collect each peer result with its own origin space. */
export declare function collectMemoryEvidence(result: unknown, space: string): MemoryEvidence[];
/** Validates shape and exact witnessed quotations, not entailment, authority,
 * absence of competing claims, or freshness after the read. */
export declare function validateMemoryAnswer(contract: MemoryAnswerContract, value: unknown, evidence: readonly MemoryEvidence[]): {
    ok: true;
    value: MemoryAnswer;
} | {
    ok: false;
    errors: string[];
};
/** Creates a caller-selected quotation from evidence without making truth or
 * freshness judgments. Quote must be an exact substring of evidence.text and
 * must not be empty or whitespace-only. Does not mutate evidence. */
export declare function createMemoryCitation(evidence: MemoryEvidence, quote: string): MemoryCitation;
```

## memory-assistance

[Source](../../src/sdk/memory-assistance.ts)

```typescript
import type { MemoryAnswer, MemoryAnswerContract } from "./memory-answer.js";
/** Adoption closes the loop: the requester (or a writer on a shared target)
 * turns an `answered` proposal into a versioned record with the `adopt`
 * operation (`POST /assistance/:id/adopt`, `/spaces/:space/adopt`, world
 * `memory adopt <ID>`). Adopting into an institutional space is a ratification
 * (standing-gated, `metadata.ratified_by`). Standing credit lands on the
 * helper — see `MemoryAdoptInput` / `MemoryAdoptResult` in `memory-types`. */
export type { MemoryAdoptInput, MemoryAdoptResult, MemoryRatifiedBy } from "./memory-types.js";
export declare const MEMORY_HELPER_ROLES: readonly ["librarian", "reflector", "evaluator"];
export type MemoryHelperRole = (typeof MEMORY_HELPER_ROLES)[number];
/** Assistance is explicitly delegated reading and a cited proposal, never a
 * grant to edit the requester's memories or to certify a claim as true. */
export interface MemoryAssistanceInput {
    worker_id: string;
    role: MemoryHelperRole;
    task: string;
    max_operations?: number;
    timeout_ms?: number;
}
export interface MemoryAssistanceJob {
    id: string;
    space_id: string;
    requester_id: string;
    worker_id: string;
    role: MemoryHelperRole;
    parent_id: string | null;
    root_id: string;
    depth: number;
    state: "pending" | "running" | "answered" | "abstained" | "cancelled";
    /** Live deadline/ancestor projection; state retains the last recorded transition. */
    work_open: boolean;
    version: number;
    lease_until: number | null;
    deadline: number;
    remaining_operations: number;
    input_source_id: string;
    result_record_id: string | null;
    created_at: number;
    task?: string;
    result?: MemoryAnswer;
}
export interface MemoryAssistanceListInput {
    open?: boolean;
    limit?: number;
    cursor?: string;
}
export interface MemoryAssistancePage {
    jobs: MemoryAssistanceJob[];
    next_cursor: string | null;
}
export declare const MEMORY_ASSISTANCE_READS: readonly ["retrieve", "search", "query", "graph", "get", "source_search", "source_range", "vocabulary", "review"];
export declare const MEMORY_ASSISTANCE_CONTRACT: MemoryAnswerContract;
export declare const MEMORY_HELPER_INSTRUCTIONS: Record<MemoryHelperRole, string>;
```

## memory-assistance-client

[Source](../../src/sdk/memory-assistance-client.ts)

```typescript
import type { MemoryAnswer } from "./memory-answer.js";
import { type MemoryAssistanceInput, type MemoryAssistanceJob, type MemoryAssistanceListInput, type MemoryAssistancePage } from "./memory-assistance.js";
import type { MarinaMemoryClient } from "./memory-client.js";
import { type MemoryOperationRequest } from "./memory-operations.js";
import { type MemoryTaskOptions } from "./memory-task.js";
/** Same protocol over HTTP or a resident's correlated memoryService transport. */
export declare class MarinaMemoryAssistance {
    private dispatch;
    constructor(dispatch: (request: MemoryOperationRequest) => Promise<unknown>);
    static http(client: MarinaMemoryClient): MarinaMemoryAssistance;
    create(space: string, input: MemoryAssistanceInput, key?: string): Promise<{
        id: string;
    }>;
    jobs(input?: MemoryAssistanceListInput): Promise<MemoryAssistancePage>;
    get(id: string): Promise<MemoryAssistanceJob>;
    cancel(id: string): Promise<unknown>;
    claim(id: string, key?: string): Promise<{
        id: string;
        lease_token: string;
        lease_until: number;
    }>;
    heartbeat(id: string, lease: string, key?: string): Promise<{
        id: string;
        lease_until: number;
    }>;
    delegate(id: string, lease: string, input: Pick<MemoryAssistanceInput, "worker_id" | "role" | "task">, key?: string): Promise<{
        id: string;
    }>;
    read(id: string, lease: string, request: MemoryOperationRequest, key?: string): Promise<unknown>;
    finish(id: string, lease: string, completion: MemoryAnswer, key?: string): Promise<unknown>;
    /** Optional bounded agent loop. `next` may call Marina's own model endpoint,
     * any other model, or a human. Storage never needs a particular model. */
    work(id: string, options: Pick<MemoryTaskOptions, "next" | "signal" | "maxTurns">): Promise<import("./memory-task.js").MemoryTaskResult>;
}
```

## memory-client

[Source](../../src/sdk/memory-client.ts)

```typescript
import type { MemoryGraphAction, MemoryGraphInputs, MemoryGraphResults } from "./memory-knowledge-graph.js";
import type { MemoryTransferFilter, MemoryTransferHeader, MemoryTransferList, MemoryTransferPage, MemoryTransferStatus } from "./memory-transfer.js";
import type { ForgetMemoryInput, MemoryAdoptInput, MemoryAdoptResult, MemoryBundle, MemoryCachedRetrievalInput, MemoryCachedRetrievalResult, MemoryCacheInput, MemoryCacheResult, MemoryCacheWrite, MemoryCheckpoint, MemoryFederatedRead, MemoryFederatedResult, MemoryFederatedRetrievalResult, MemoryFederatedSearch, MemoryGraphQuery, MemoryGraphResult, MemoryJobStatus, MemoryPlan, MemoryPlanResult, MemoryPlanStep, MemoryQuery, MemoryQueryResult, MemoryReceipt, MemoryRecord, MemoryRecordInput, MemoryResolveInput, MemoryResolveResult, MemoryRetrievalInput, MemoryRetrievalResult, MemoryReviewResult, MemorySearchInput, MemorySearchResult, MemorySource, MemorySourceRange, MemorySourceSearch, MemorySourceSearchResult, MemorySpace, MemoryStorageUsage, MemoryVocabulary, MemoryVocabularyDefinition } from "./memory-types.js";
import { MarinaMemoryWorkflows } from "./memory-workflows.js";
export declare class MemoryClientError extends Error {
    status: number;
    code: string;
    retryAfterMs?: number | undefined;
    constructor(status: number, code: string, message: string, retryAfterMs?: number | undefined);
}
/** Fetch-only client. It never opens a DB, joins a world, or invokes a model. */
export declare class MarinaMemoryClient {
    readonly url: string;
    private token;
    private timeoutMs;
    private fetcher;
    private signal?;
    federatedRetrieve(space: string, mounts: string[], retrieval: MemoryRetrievalInput, allow_partial?: boolean): Promise<MemoryFederatedRetrievalResult>;
    retrieveCached(space: string, input: MemoryCachedRetrievalInput, key?: string): Promise<MemoryCachedRetrievalResult>;
    workflows(space: string, journalSpace?: string): MarinaMemoryWorkflows;
    constructor(url: string, token: string, timeoutMs?: number, fetcher?: (request: Request) => Promise<Response>, signal?: AbortSignal | undefined);
    /** A per-operation view; concurrent users of the original client are unaffected. */
    withSignal(signal: AbortSignal): MarinaMemoryClient;
    request<T>(path: string, method?: string, body?: unknown, key?: string): Promise<T>;
    private path;
    knowledgeGraph<A extends MemoryGraphAction>(space: string, action: A, ...args: A extends "read_graph" ? [input?: MemoryGraphInputs[A], key?: string] : [input: MemoryGraphInputs[A], key?: string]): Promise<MemoryGraphResults[A]>;
    review(space: string, input?: {
        kind?: "all" | "stale" | "competing" | "pending";
        limit?: number;
        cursor?: string;
    }): Promise<MemoryReviewResult>;
    /** Adopt an answered assistance proposal as a record. `space` is the target
     * (pass `undefined` for the job's own space). Adopting into an institutional
     * space is a standing-gated ratification. Same job + same space ⇒ same record. */
    adopt(space: string | undefined, jobId: string, input?: Omit<MemoryAdoptInput, "job_id">, key?: string): Promise<MemoryAdoptResult>;
    /** Explicit contradiction resolution; `id` is the head record, `input.competing`
     * its rivals. Reuse `key` to replay the same decision idempotently. */
    resolve(space: string, id: string, input: MemoryResolveInput, key?: string): Promise<MemoryResolveResult>;
    reaffirm(space: string, id: string, expected_version: number, dependency_versions: Record<string, number>, content?: string, key?: string): Promise<MemoryReceipt>;
    cacheDelete(space: string, input: MemoryCacheInput, key?: string): Promise<MemoryReceipt & {
        removed: boolean;
    }>;
    cacheGet(space: string, input: MemoryCacheInput): Promise<MemoryCacheResult>;
    cachePut(space: string, input: MemoryCacheWrite, key?: string): Promise<MemoryReceipt>;
    acknowledge(space: string, keys: string[]): Promise<{
        acknowledged: string[];
        missing: string[];
    }>;
    exportBundle(space: string): Promise<MemoryBundle>;
    exportTransferPage(space: string, cursor?: string): Promise<MemoryTransferPage>;
    exportTransferPages(space: string, cursor?: string): AsyncGenerator<MemoryTransferPage>;
    beginTransfer(space: string, header: MemoryTransferHeader, key?: string): Promise<MemoryTransferStatus>;
    transferStatus(space: string, id: string): Promise<MemoryTransferStatus>;
    transfers(space: string, input?: MemoryTransferFilter): Promise<MemoryTransferList>;
    appendTransfer(space: string, id: string, page: MemoryTransferPage, key?: string): Promise<MemoryTransferStatus>;
    commitTransfer(space: string, id: string, sha256: string, key?: string): Promise<MemoryReceipt & {
        portable_ids_preserved: boolean;
    }>;
    abortTransfer(space: string, id: string, key?: string): Promise<MemoryReceipt>;
    importBundle(space: string, bundle: MemoryBundle | Record<string, unknown>, key?: string): Promise<MemoryReceipt & {
        portable_ids_preserved: boolean;
    }>;
    federationMounts(space: string): Promise<{
        mounts: string[];
    }>;
    federatedSearch(space: string, input: MemoryFederatedSearch): Promise<MemoryFederatedResult>;
    federatedRead(space: string, input: MemoryFederatedRead): Promise<{
        origin: {
            mount: string;
            space_id: string;
            id: string;
        };
        result: MemoryRecord | MemorySourceRange;
    }>;
    me(): Promise<{
        principal_id: string;
        credential_id: string;
        scopes: string[];
    }>;
    usage(): Promise<MemoryStorageUsage>;
    capabilities(): Promise<Record<string, unknown>>;
    spaces(): Promise<{
        spaces: MemorySpace[];
    }>;
    createSpace(name: string, key?: string): Promise<MemoryReceipt>;
    space(id: string): Promise<MemorySpace>;
    remember(space: string, input: MemoryRecordInput, key?: string): Promise<MemoryReceipt>;
    get(space: string, id: string, version?: number): Promise<MemoryRecord>;
    revise(space: string, id: string, expected_version: number, input: MemoryRecordInput, key?: string): Promise<MemoryReceipt>;
    search(space: string, input: MemorySearchInput): Promise<MemorySearchResult>;
    join(space: string, input: import("./memory-symbolic.js").MemoryJoin): Promise<import("./memory-symbolic.js").MemoryJoinResult>;
    saveRule(space: string, rule: import("./memory-symbolic.js").MemoryRule, options?: {
        id?: string;
        expected_version?: number;
        source_ids?: string[];
    }, key?: string): Promise<MemoryReceipt>;
    runRule(space: string, id: string, expected_version: number, valid_at?: number): Promise<import("./memory-symbolic.js").MemoryRuleResult>;
    materializeRule(space: string, id: string, expected_version: number, valid_at?: number, key?: string): Promise<MemoryReceipt & {
        records: MemoryReceipt[];
    }>;
    query(space: string, input?: MemoryQuery): Promise<MemoryQueryResult>;
    graph(space: string, input: MemoryGraphQuery): Promise<MemoryGraphResult>;
    reindex(space: string, expected_generation: number, key?: string, page?: {
        cursor?: string;
        limit?: number;
    }): Promise<MemoryReceipt & {
        model: string;
        job_ids: string[];
        examined: number;
        next_cursor: string | null;
        generation: number;
    }>;
    context(space: string, input: MemorySearchInput & {
        budget_tokens?: number;
    }): Promise<{
        text: string;
        citations: {
            id: string;
            version: number;
            source_ids: string[];
            truncated: boolean;
        }[];
        estimated_tokens: number;
        generation: number;
        degraded: string[];
    }>;
    capture(space: string, content: unknown, session_id?: string, key?: string): Promise<MemoryReceipt>;
    sources(space: string, after?: number, limit?: number): Promise<{
        sources: MemorySource[];
        next_cursor: number;
    }>;
    sourceHeaders(space: string, after?: number, limit?: number): Promise<{
        sources: Omit<MemorySource, "body">[];
        next_cursor: number | null;
    }>;
    captureBatch(space: string, items: {
        content: unknown;
        session_id?: string;
        key: string;
    }[], key?: string): Promise<MemoryReceipt & {
        receipts: MemoryReceipt[];
    }>;
    sourceSearch(space: string, input: MemorySourceSearch): Promise<MemorySourceSearchResult>;
    vocabulary(space: string, version?: number): Promise<MemoryVocabulary>;
    plan(space: string, input: {
        task: string;
        use_model?: boolean;
        steps?: MemoryPlanStep[];
        max_results?: number;
        max_bytes?: number;
    }): Promise<MemoryPlan>;
    executePlan(space: string, plan: MemoryPlan): Promise<MemoryPlanResult>;
    /** Find and read citable evidence in one bounded request; never generates an answer. */
    retrieve(space: string, input: MemoryRetrievalInput): Promise<MemoryRetrievalResult>;
    saveVocabulary(space: string, expected_version: number, definition: MemoryVocabularyDefinition, key?: string): Promise<MemoryReceipt>;
    sourceRange(space: string, id: string, input?: {
        start?: number;
        end?: number;
        text_hash?: string;
    }): Promise<MemorySourceRange>;
    checkpoint(space: string, name: string): Promise<MemoryCheckpoint>;
    saveCheckpoint(space: string, name: string, expected_version: number, data: Record<string, unknown>, source_cursor?: number, key?: string, source_ids?: string[]): Promise<MemoryReceipt>;
    grant(space: string, principal_id: string, role: "reader" | "writer" | null, key?: string): Promise<MemoryReceipt>;
    forget(space: string, input: ForgetMemoryInput, key?: string): Promise<MemoryReceipt>;
    export(space: string): Promise<Record<string, unknown>>;
    job(space: string, id: string): Promise<MemoryJobStatus>;
    waitForIndex(space: string, receipt: MemoryReceipt, timeoutMs?: number): Promise<void>;
}
```

## memory-context

[Source](../../src/sdk/memory-context.ts)

```typescript
export type UnifiedTier = "skill" | "trusted" | "evidence" | "proposal" | "unverified";
export interface UnifiedContextItem {
    tier: UnifiedTier;
    /** Legacy note id (`"12"`), durable record/source id, or assistance job id. */
    id: string;
    /** Rendered content — already truncated (with a visible marker) when `truncated`. */
    content: string;
    /** Human-readable origin: `#12 imp=6 verified`, `record r_1 v1`, `source s_1 sha256:…`. */
    provenance: string;
    /** UTF-8 bytes of `content` after truncation — what counted against the budget. */
    bytes: number;
    /** Ranking key within the tier (score desc, then id asc). */
    score: number;
    truncated?: boolean;
    /** Structured origin details for machine consumers (record version, hash, citations…). */
    meta?: Record<string, unknown>;
}
export interface UnifiedTierResult {
    tier: UnifiedTier;
    label: string;
    items: UnifiedContextItem[];
    /** Items that matched but were dropped for budget — the header still renders. */
    omitted: number;
}
export interface UnifiedDegraded {
    tier: UnifiedTier;
    code: string;
    message: string;
}
export interface UnifiedContextResult {
    schema: "marina.memory.context.v1";
    entity: string;
    query: string;
    scope: UnifiedScope;
    budgetBytes: number;
    usedBytes: number;
    /** True when any item was cut or dropped for budget. Headers are never dropped silently. */
    truncated: boolean;
    /** All five tiers, in render order; empty tiers have `items: []`. */
    tiers: UnifiedTierResult[];
    degraded: UnifiedDegraded[];
}
export type UnifiedScope = "all" | "evidence" | "legacy";
export interface UnifiedContextOptions {
    /** Total content-byte budget across tiers. Default 2048 (prompt use). */
    budgetBytes?: number;
    /** Per-item cap before the global budget applies. Default 600. */
    itemMaxBytes?: number;
    /** `all` (default) · `evidence` (durable tiers only) · `legacy` (notes only). */
    scope?: UnifiedScope;
    /** Max items fetched per tier before budgeting. */
    perTier?: Partial<Record<UnifiedTier, number>>;
    /** Legacy recall weights (the `recall` command passes its intent-detected weights). */
    weights?: {
        weightImportance: number;
        weightRecency: number;
        weightRelevance: number;
    };
    /** Restrict legacy note tiers to one note_type (mirrors `recall … type <t>`). */
    noteType?: string;
    /** Pay authors of cross-author reflection hits in the legacy tiers (default true). */
    creditReflections?: boolean;
}
```

## memory-expansion

[Source](../../src/sdk/memory-expansion.ts)

```typescript
/** Caller-selected alternatives are retrieval hints, never new assertions. */
export interface MemoryQueryExpansion {
    policy: string;
    queries: string[];
}
export interface MemoryQueryVocabulary {
    policy: string;
    rules: {
        term: string;
        alternatives: string[];
    }[];
}
export interface MemoryExpansionCoverage extends MemoryQueryExpansion {
    candidates: number[];
    candidate_limit: number;
    fusion: "mean-alternatives-rrf:k=60";
}
/** Validate even ignored duplicates, then deduplicate without changing authored text. */
export declare function normalizeMemoryExpansion(query: string, raw: unknown): MemoryQueryExpansion | undefined;
/** Literal, nonrecursive substitutions against the original query only.
 * Rule order determines which four alternatives fit; inspect `truncated`.
 * Supply/persist this JSON vocabulary yourself; no model or global registry. */
export declare function expandMemoryQuery(query: string, vocabulary: MemoryQueryVocabulary): {
    query: string;
    expansion: {
        policy: string;
        queries: string[];
    };
    applied: {
        term: string;
        alternative: string;
        query: string;
    }[];
    truncated: boolean;
};
```

## memory-knowledge-graph

[Source](../../src/sdk/memory-knowledge-graph.ts)

```typescript
/** Named reference MCP memory tool contract; native history/grants remain Marina's. */
export declare const MEMORY_GRAPH_ACTIONS: readonly ["create_entities", "create_relations", "add_observations", "delete_entities", "delete_observations", "delete_relations", "read_graph", "search_nodes", "open_nodes"];
export type MemoryGraphAction = (typeof MEMORY_GRAPH_ACTIONS)[number];
export interface MemoryGraphEntity {
    name: string;
    entityType: string;
    observations: string[];
}
export interface MemoryGraphRelation {
    from: string;
    to: string;
    relationType: string;
}
export interface MemoryKnowledgeGraph {
    entities: MemoryGraphEntity[];
    relations: MemoryGraphRelation[];
}
export interface MemoryGraphInputs {
    create_entities: {
        entities: MemoryGraphEntity[];
    };
    create_relations: {
        relations: MemoryGraphRelation[];
    };
    add_observations: {
        observations: {
            entityName: string;
            contents: string[];
        }[];
    };
    delete_entities: {
        entityNames: string[];
    };
    delete_observations: {
        deletions: {
            entityName: string;
            observations: string[];
        }[];
    };
    delete_relations: {
        relations: MemoryGraphRelation[];
    };
    read_graph: Record<string, never>;
    search_nodes: {
        query: string;
    };
    open_nodes: {
        names: string[];
    };
}
export interface MemoryGraphResults {
    create_entities: {
        entities: MemoryGraphEntity[];
    };
    create_relations: {
        relations: MemoryGraphRelation[];
    };
    add_observations: {
        results: {
            entityName: string;
            addedObservations: string[];
        }[];
    };
    delete_entities: {
        deleted: string[];
        notFound: string[];
    };
    delete_observations: {
        deletedCount: number;
        missingEntities: string[];
    };
    delete_relations: {
        deletedCount: number;
    };
    read_graph: MemoryKnowledgeGraph;
    search_nodes: MemoryKnowledgeGraph;
    open_nodes: MemoryKnowledgeGraph;
}
```

## memory-operations

[Source](../../src/sdk/memory-operations.ts)

```typescript
import { type MarinaMemoryClient } from "./memory-client.js";
export declare const MEMORY_OPERATIONS: readonly ["workflow", "federated_retrieve", "retrieve_cached", "assist_create", "assist_jobs", "assist_get", "assist_claim", "assist_heartbeat", "assist_read", "assist_finish", "assist_cancel", "assist_delegate", "adopt", "capabilities", "usage", "federation_mounts", "federated_search", "federated_read", "export_bundle", "import_bundle", "knowledge_graph", "export_page", "transfer_begin", "transfer_status", "transfers", "transfer_page", "transfer_commit", "transfer_abort", "acknowledge", "review", "reaffirm", "resolve", "cache_delete", "cache_get", "cache_put", "me", "spaces", "create_space", "space", "remember", "get", "revise", "query", "join", "json_store", "save_rule", "run_rule", "materialize_rule", "graph", "search", "context", "capture", "capture_batch", "sources", "source_headers", "source_search", "source_range", "vocabulary", "save_vocabulary", "plan", "execute_plan", "retrieve", "checkpoint", "save_checkpoint", "grant", "forget", "export", "job", "reindex"];
export interface MemoryOperationRequest {
    operation: (typeof MEMORY_OPERATIONS)[number];
    request_id?: string;
    space_id?: string;
    id?: string;
    input?: Record<string, unknown>;
    key?: string;
}
export type MemoryOperationResult = {
    ok: true;
    result: unknown;
    space_id?: string;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
        status: number;
        retry_after_ms?: number;
    };
};
/** Canonical memory access bound by the host to the current caller. Errors reject
 * with MemoryClientError; credentials and caller identity are never caller inputs. */
export interface DurableMemoryAPI {
    run(request: MemoryOperationRequest): Promise<{
        ok: true;
        result: unknown;
        space_id?: string;
    }>;
}
/** Shared transport vocabulary. The service validates all operation payloads. */
export declare function runMemoryOperation(client: MarinaMemoryClient, request: MemoryOperationRequest, defaultSpace?: string, signal?: AbortSignal): Promise<unknown>;
export declare function memoryOperationError(error: unknown): MemoryOperationResult;
```

## memory-portable

[Source](../../src/sdk/memory-portable.ts)

```typescript
/** Locale-independent canonical JSON for the versioned portable bundle contract. */
export declare function canonicalPortableMemory(value: unknown): string;
export declare function memoryPortableDigest(value: unknown): Promise<string>;
```

## memory-recipes

[Source](../../src/sdk/memory-recipes.ts)

```typescript
import type { MemoryRetrievalInput, MemoryRetrievalResult, MemoryRetrievedEvidence } from "./memory-types.js";
export type MemorySelection = "sources_first" | "balanced" | "records_first";
export interface MemoryRecipe {
    schema: "marina.memory.policy.v1";
    name: string;
    description: string;
    retrieval: Omit<MemoryRetrievalInput, "task" | "observe" | "use_model">;
    prerequisites: string[];
    exceptions: string[];
    compatibility: "marina.memory.retrieval.v1";
    evidence: {
        space_id: string;
        id: string;
        version: number;
    }[];
}
export interface MemoryRetrievalObservation {
    schema: "marina.memory.observation.v1";
    input: MemoryRetrievalInput;
    result: MemoryRetrievalResult;
    /** Authored/exported observations are evidence, not certified executions. */
    attribution: string;
}
/** The same bounded selection interpreter is used by live reads and offline comparisons. */
export declare function selectMemoryEvidence(candidates: MemoryRetrievedEvidence[], selection: MemorySelection, budget: {
    max_results: number;
    max_bytes: number;
}): {
    evidence: MemoryRetrievedEvidence[];
    bytes: number;
    omitted: number;
    clipped: boolean;
};
/** No I/O. Different discovery, temporal context, or larger observation envelopes require a live trial. */
export declare function compareMemoryRecipes(observation: MemoryRetrievalObservation, recipes: MemoryRecipe[]): {
    schema: "marina.experience.comparison.v1";
    attribution: string;
    context: {
        space_id: string;
        retrieval_generation: number;
        vocabulary_version: number;
        valid_at: number;
    };
    candidates: ({
        name: string;
        status: "unsupported";
        reason: string;
    } | {
        evidence: MemoryRetrievedEvidence[];
        bytes: number;
        omitted: number;
        clipped: boolean;
        reason?: undefined;
        name: string;
        status: "observed_only";
        discovery_truncated: boolean;
    })[];
    answer_quality: "not_assessed";
    limitations: string[];
};
```

## memory-retry

[Source](../../src/sdk/memory-retry.ts)

```typescript
/** Opt-in retry of the SAME request/key. Never reinterpret conflicts or denial. */
export declare function retryMemoryOperation<T>(operation: () => Promise<T>, options?: {
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
}): Promise<T>;
```

## memory-symbolic

[Source](../../src/sdk/memory-symbolic.ts)

```typescript
import type { MemoryClaim, MemoryTerm, MemoryValidity } from "./memory-types.js";
export type MemoryVariable = {
    variable: string;
    type: "entity" | "symbol" | "string" | "number" | "boolean" | "null";
};
export interface MemoryPattern {
    subject: string | MemoryVariable;
    predicate: string | MemoryVariable;
    object: MemoryTerm | MemoryVariable;
}
export interface MemoryJoin {
    patterns: MemoryPattern[];
    select?: string[];
    valid_at?: number;
    limit?: number;
}
export type MemoryBinding = MemoryTerm | {
    kind: "symbol";
    value: string;
};
export interface MemoryMatch {
    bindings: Record<string, MemoryBinding>;
    witnesses: {
        id: string;
        version: number;
    }[];
    valid_time: MemoryValidity;
}
export interface MemoryJoinResult {
    space_id: string;
    generation: number;
    results: MemoryMatch[];
    truncated: boolean;
    trace: {
        pattern: number;
        candidates: number;
        matches: number;
    }[];
    semantics: "asserted-nonrecursive";
}
export interface MemoryRule {
    schema: "marina.memory.rule.v1";
    name: string;
    query: MemoryJoin;
    conclusion: MemoryPattern;
}
export interface MemoryRuleResult extends MemoryJoinResult {
    rule: {
        id: string;
        version: number;
    };
    results: (MemoryMatch & {
        claim: MemoryClaim;
    })[];
}
```

## memory-task

[Source](../../src/sdk/memory-task.ts)

```typescript
import { type MemoryAnswer, type MemoryAnswerContract } from "./memory-answer.js";
import type { MemoryOperationRequest } from "./memory-operations.js";
export interface MemoryTaskMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
export interface MemoryTaskOptions {
    task: string;
    space: string;
    contract: MemoryAnswerContract;
    instructions?: string;
    operations: MemoryOperationRequest["operation"][];
    next: (messages: readonly MemoryTaskMessage[], signal?: AbortSignal) => Promise<string>;
    dispatch: (request: MemoryOperationRequest, signal?: AbortSignal) => Promise<unknown>;
    maxTurns?: number;
    maxRepairs?: number;
    signal?: AbortSignal;
}
export interface MemoryTaskResult {
    status: "answered" | "abstained" | "exhausted" | "error" | "cancelled";
    completion: MemoryAnswer | null;
    errors: string[];
    responses: string[];
    trace: {
        request: MemoryOperationRequest;
        result: unknown;
    }[];
    turns: number;
}
/** Optional model-neutral caller loop. The model chooses operations and claims;
 * the caller declares their contract and capabilities. No truth selection. */
export declare function runMemoryTask(options: MemoryTaskOptions): Promise<MemoryTaskResult>;
```

## memory-transfer

[Source](../../src/sdk/memory-transfer.ts)

```typescript
export declare const MEMORY_TRANSFER_KINDS: readonly ["source", "record", "revision", "vocabulary", "checkpoint"];
export type MemoryTransferKind = (typeof MEMORY_TRANSFER_KINDS)[number];
export interface MemoryTransferHeader {
    schema: "marina.memory.transfer.v1";
    origin_space: string;
    generation: number;
    counts: Record<MemoryTransferKind, number>;
}
export interface MemoryTransferFragment {
    kind: MemoryTransferKind;
    id: string;
    version: number;
    offset: number;
    size: number;
    sha256: string;
    base64: string;
}
export interface MemoryTransferPage {
    header: MemoryTransferHeader;
    position: number;
    previous: string;
    fragments: MemoryTransferFragment[];
    done: boolean;
    sha256: string;
    next_cursor: string | null;
}
export interface MemoryTransferStatus {
    id: string;
    header: MemoryTransferHeader;
    state: "receiving" | "ready" | "committed" | "aborted";
    position: number;
    sha256: string;
    bytes: number;
    next_cursor: string | null;
    expires_at: number;
}
export interface MemoryTransferList {
    transfers: (MemoryTransferStatus & {
        expired: boolean;
    })[];
    next_cursor: string | null;
}
export interface MemoryTransferFilter {
    state?: MemoryTransferStatus["state"];
    expired?: boolean;
    limit?: number;
    cursor?: string;
}
```

## memory-transfer-client

[Source](../../src/sdk/memory-transfer-client.ts)

```typescript
import { type MarinaMemoryClient } from "./memory-client.js";
import type { MemoryTransferStatus } from "./memory-transfer.js";
/** Move pages outside model context; durable status and stable request keys survive restarts. */
export declare function resumeMemoryTransfer(destination: MarinaMemoryClient, space: string, id: string, options?: {
    source?: MarinaMemoryClient;
    signal?: AbortSignal;
    progress?: (status: MemoryTransferStatus) => void;
}): Promise<MemoryTransferStatus>;
```

## memory-types

[Source](../../src/sdk/memory-types.ts)

```typescript
import type { MemoryExpansionCoverage, MemoryQueryExpansion } from "./memory-expansion.js";
export type MemoryTerm = {
    kind: "entity";
    id: string;
} | {
    kind: "literal";
    value: string | number | boolean | null;
};
export interface MemoryClaim {
    subject: string;
    predicate: string;
    object: MemoryTerm;
}
export interface MemoryQuery {
    include_stale?: boolean;
    valid_at?: number;
    subject?: string;
    predicate?: string;
    object?: MemoryTerm;
    type?: string;
    tier?: string;
    limit?: number;
    cursor?: string;
}
export interface MemoryQueryResult {
    space_id: string;
    generation: number;
    mode: "symbolic";
    results: MemoryRecord[];
    next_cursor: string | null;
}
export interface MemoryGraphQuery {
    include_stale?: boolean;
    valid_at?: number;
    subject: string;
    predicates?: string[];
    direction?: "out" | "in" | "both";
    max_depth?: number;
    limit?: number;
}
export interface MemoryGraphResult {
    space_id: string;
    generation: number;
    root: string;
    edges: {
        record: MemoryRecord;
        path: string[];
    }[];
    truncated: boolean;
}
export interface MemoryRecordInput {
    dependency_versions?: Record<string, number>;
    valid_time?: MemoryValidity | null;
    expected_vocabulary_version?: number;
    content: string;
    type?: "fact" | "observation" | "decision" | "inference" | "skill" | "episode";
    tier?: "fact" | "reflection" | "skill";
    importance?: number;
    subject?: string;
    metadata?: Record<string, unknown>;
    source_ids?: string[];
    depends_on?: string[];
    claim?: MemoryClaim | null;
}
export interface MemoryRecord {
    freshness?: "current" | "stale" | "historical";
    stale_reason?: {
        kind: string;
        record_id?: string;
        observed_version?: number;
    } | null;
    dependency_versions?: Record<string, number | null>;
    valid_time?: MemoryValidity | null;
    vocabulary_version?: number;
    id: string;
    space_id: string;
    version: number;
    content: string;
    type: string;
    tier: string;
    importance: number;
    subject: string | null;
    metadata: Record<string, unknown>;
    source_ids: string[];
    depends_on: string[];
    created_at: number;
    claim?: MemoryClaim | null;
}
export interface MemoryValidity {
    from: number | null;
    until: number | null;
}
export interface MemoryVocabularyDefinition {
    closed: boolean;
    predicates: Record<string, {
        object: "entity" | "string" | "number" | "boolean" | "null";
        cardinality: "one" | "many";
        description?: string;
    }>;
}
export interface MemoryVocabulary {
    version: number;
    definition: MemoryVocabularyDefinition;
}
export interface MemoryPlanStep {
    operation: "query" | "graph" | "search" | "source_search" | "join";
    input: Record<string, unknown>;
}
export interface MemoryPlan {
    retrieval_generation?: number;
    schema: "marina.memory.plan.v1";
    space_id: string;
    generation: number;
    vocabulary_version: number;
    task: string;
    planner: string;
    assumptions: string[];
    steps: MemoryPlanStep[];
    budget: {
        max_results: number;
        max_bytes: number;
    };
}
export interface MemoryPlanResult {
    space_id: string;
    generation: number;
    trace: {
        operation: MemoryPlanStep["operation"];
        input: Record<string, unknown>;
        evidence: unknown[];
        truncated: boolean;
    }[];
    bytes: number;
    truncated: boolean;
    answer_sufficiency: "not_assessed";
}
/** One bounded retrieval, including witnessed original-source reads. */
export interface MemoryRetrievalInput {
    task: string;
    selection?: import("./memory-recipes.js").MemorySelection;
    expansion?: MemoryQueryExpansion;
    requirements?: ({
        kind: "claim";
        subject: string;
        predicate: string;
    } | {
        kind: "source";
        id: string;
        start?: number;
        end?: number;
    })[];
    /** Include a bounded candidate pool for explicit episode capture and offline comparison. */
    observe?: boolean;
    steps?: MemoryPlanStep[];
    use_model?: boolean;
    broaden?: boolean;
    valid_at?: number;
    max_results?: number;
    /** Serialized evidence-array budget; plan and diagnostic metadata are separate. */
    max_bytes?: number;
    /** Maximum UTF-8 text bytes read per original source. */
    source_bytes?: number;
}
export type MemoryRetrievedEvidence = (MemoryRecord & {
    kind: "record";
}) | (MemorySourceRange & {
    kind: "source";
    space_id: string;
});
export interface MemoryRetrievalResult {
    schema: "marina.memory.retrieval.v1";
    space_id: string;
    generation: number;
    retrieval_generation: number;
    vocabulary_version: number;
    valid_at: number;
    status: "evidence" | "empty" | "budget_exhausted";
    plan: MemoryPlan;
    evidence: MemoryRetrievedEvidence[];
    trace: {
        operation: MemoryPlanStep["operation"] | "source_range";
        input: Record<string, unknown>;
        returned: number;
        truncated: boolean;
        reason: "planned" | "empty_source_search" | "sparse_source_search" | "read_original";
    }[];
    budget: {
        max_results: number;
        max_bytes: number;
        source_bytes: number;
    };
    bytes: number;
    truncated: boolean;
    answer_sufficiency: "not_assessed";
    selection?: import("./memory-recipes.js").MemorySelection;
    selection_contract?: "marina-evidence-selection-v1";
    selected_recipe?: {
        space_id: string;
        id: string;
        version: number;
    };
    observed_candidates?: MemoryRetrievedEvidence[];
    coverage?: {
        requirement: NonNullable<MemoryRetrievalInput["requirements"]>[number];
        covered: boolean;
    }[];
    known_conflicts?: {
        subject: string;
        predicate: string;
        records: string[];
    }[];
    diagnostics: {
        broadened: boolean;
        discovery_truncated: boolean;
        budget_limited: boolean;
        filtered_records: number;
        partial_sources: number;
        next_actions: string[];
    };
    limitations: string[];
}
export interface MemorySpace {
    retrieval_generation: number;
    id: string;
    owner_id: string;
    name: string;
    generation: number;
    status: "active" | "forgotten";
    created_at: number;
    /** Operator-set flags (migration 114). `institutional: true` makes `adopt`
     * a standing-gated ratification; `read_public: true` grants every active
     * credential read access. Never settable over HTTP. */
    metadata: Record<string, unknown>;
}
export interface MemorySource {
    id: string;
    space_id: string;
    seq: number;
    session_id: string | null;
    body: unknown;
    content_hash: string;
    created_at: number;
}
export interface MemorySourceSearch {
    query: string;
    expansion?: MemoryQueryExpansion;
    match?: "all" | "any" | "phrase";
    session_id?: string;
    limit?: number;
}
export interface MemorySourceRange {
    id: string;
    session_id: string | null;
    content_hash: string;
    text_hash: string;
    representation: "utf8-source-text-v1";
    start: number;
    end: number;
    total_bytes: number;
    next_start: number | null;
    text: string;
}
export interface MemorySourceSearchResult {
    expansion?: MemoryExpansionCoverage;
    space_id: string;
    generation: number;
    results: {
        id: string;
        seq: number;
        session_id: string | null;
        content_hash: string;
        excerpt: string;
        score?: number;
        ranks?: {
            lexical?: number;
            expansion?: (number | null)[];
        };
    }[];
    truncated: boolean;
}
export interface MemoryCheckpoint {
    name: string;
    version: number;
    source_cursor: number;
    data: Record<string, unknown>;
    updated_at: number;
}
export interface MemoryReceipt {
    id: string;
    version?: number;
    job_id?: string;
    seq?: number;
    generation?: number;
}
export interface MemoryFilter {
    include_stale?: boolean;
    subject?: string;
    type?: string;
    tier?: string;
}
export interface MemorySearchInput extends MemoryFilter {
    query: string;
    expansion?: MemoryQueryExpansion;
    limit?: number;
    mode?: "lexical" | "hybrid";
    allow_degraded?: boolean;
}
/** Reputation-weighted re-rank applied to SHARED-space search results (records the
 *  actor does not own). Bounded, inspectable, deterministic — see db-memory-ranking.ts. */
export interface MemoryReputationRanking {
    weight: number;
    standing_ceiling: number;
    applied: number;
    considered: number;
    authors: Record<string, {
        author: string | null;
        standing: number;
        term: number;
    }>;
}
export interface MemorySearchResult {
    /** Present only when the actor is not the space owner and ≥1 record was considered. */
    ranking?: MemoryReputationRanking;
    expansion?: MemoryExpansionCoverage;
    coverage?: {
        candidate_limit: number;
        lexical_candidates: number;
        semantic: {
            scored: number;
            missing: number;
            invalid: number;
        } | null;
    };
    space_id: string;
    generation: number;
    mode: "lexical" | "hybrid";
    model: string | null;
    degraded: string[];
    results: (MemoryRecord & {
        score: number;
        ranks: {
            lexical?: number;
            semantic?: number;
            expansion?: (number | null)[];
        };
    })[];
}
export interface ForgetMemoryInput {
    record_ids?: string[];
    source_ids?: string[];
    all?: boolean;
    expected_generation?: number;
}
export interface MemoryJobStatus {
    id: string;
    space_id: string;
    record_id: string;
    note_id: number;
    model: string;
    state: string;
    attempts: number;
    lease_until: number | null;
    error: string | null;
    created_at: number;
}
export interface MemoryStorageAmounts {
    logical_bytes: number;
    sources: number;
    revisions: number;
    spaces: number;
}
export interface MemoryStorageUsage {
    owner_id: string;
    usage: MemoryStorageAmounts;
    limits: Readonly<MemoryStorageAmounts>;
    over_limit: (keyof MemoryStorageAmounts)[];
}
export interface MemoryReviewResult {
    space_id: string;
    retrieval_generation: number;
    items: {
        record: MemoryRecord;
        premises: {
            id: string;
            pinned_version: number | null;
            current_version: number | null;
            state: string;
        }[];
        competing_records: MemoryRecord[];
        competing_truncated: boolean;
        /** The record's live resolution membership, when one exists. */
        resolution?: MemoryResolutionMembership;
    }[];
    next_cursor: string | null;
}
/** Typed write-time operators over the review queue. Every policy writes an
 * append-only audit row; none deletes history. */
export type MemoryResolvePolicy = "last_writer_wins" | "evidence_weighted" | "await_confirmation" | "keep_both";
export type MemoryResolutionStatus = "applied" | "pending" | "confirmed" | "superseded" | "retired";
export type MemoryResolutionRole = "winner" | "superseded" | "peer" | "pending";
export interface MemoryResolveInput {
    policy: MemoryResolvePolicy;
    /** Competing record IDs (1–32); the head record is the operation target. */
    competing: string[];
    rationale: string;
    /** Explicit cutoff for closing losers; `from` overrides the winner's `valid_from`. */
    valid_time?: MemoryValidity | null;
    /** await_confirmation only: relative deadline in milliseconds. */
    deadline_ms?: number;
}
export interface MemoryResolutionMembership {
    id: string;
    policy: MemoryResolvePolicy;
    status: MemoryResolutionStatus;
    role: MemoryResolutionRole;
    rationale: string;
    deadline: number | null;
    created_at: number;
}
export interface MemoryResolveResult extends MemoryReceipt {
    /** Resolution (audit row) ID. */
    id: string;
    record_id: string;
    policy: MemoryResolvePolicy;
    status: MemoryResolutionStatus;
    winner: string | null;
    superseded: {
        id: string;
        version: number;
        valid_time: MemoryValidity | null;
    }[];
    peers: string[];
    pending: string[];
    evidence_counts: Record<string, number> | null;
    deadline: number | null;
}
/** Why a record lives in a shared (institutional) space. Stamped by `adopt`
 * and `pool <name> ratify`; every institutional record answers "why is this
 * shared?" from its own metadata. */
export interface MemoryRatifiedBy {
    principal_id: string;
    name: string;
    standing: number;
    at: number;
    rationale: string | null;
    /** Which rule admitted the ratifier. */
    basis: "standing" | "sovereign" | "local-ungated";
}
export interface MemoryAdoptInput {
    job_id: string;
    /** Defaults to the job's own space. */
    target_space_id?: string;
    rationale?: string;
    valid_time?: MemoryValidity | null;
    /** Explicit `assistance_abstained_confirmed` credit for an abstained job;
     * writes no record. */
    confirm_abstention?: boolean;
}
export interface MemoryStandingCredit {
    principal_id: string;
    kind: string;
    ref: string;
    amount: number;
}
export interface MemoryAdoptResult extends MemoryReceipt {
    job_id: string;
    space_id: string;
    state: "adopted" | "abstention_confirmed";
    /** True when this call returned an adoption that already existed. */
    existing: boolean;
    ratified_by: MemoryRatifiedBy | null;
    credited: MemoryStandingCredit[];
}
export interface MemoryCacheInput {
    inputs: unknown;
    model: string;
    policy: string;
}
export interface MemoryCacheWrite extends MemoryCacheInput {
    value: unknown;
    records?: {
        id: string;
        version: number;
    }[];
    sources?: {
        id: string;
        content_hash: string;
    }[];
    federated?: MemoryFederatedPin[];
    expires_at: number;
}
export type MemoryCacheResult = {
    hit: false;
    reason: string;
} | {
    hit: true;
    value: unknown;
    records: {
        id: string;
        version: number;
    }[];
    sources: {
        id: string;
        content_hash: string;
    }[];
    federated?: MemoryFederatedPin[];
    expires_at: number;
};
/** Explicit remote provenance; mounts are configured by the operator, never URLs. */
export type MemoryFederatedPin = {
    mount: string;
    space_id: string;
    id: string;
} & ({
    kind: "record";
    version: number;
} | {
    kind: "source";
    content_hash: string;
});
/** Portable history envelope. Authorization and indexes are deliberately excluded. */
export interface MemoryBundle {
    schema: "marina.memory.bundle.v2";
    sha256: string;
    payload: {
        origin_space: string;
        sources: (MemorySource & {
            body_sha256: string;
        })[];
        records: {
            id: string;
            version: number;
            created_at: number;
            stale: number;
            stale_reason: string | null;
            versions: {
                record: MemoryRecord;
                attributes: Record<string, unknown> | null;
            }[];
        }[];
        vocabularies: {
            version: number;
            definition: string;
            created_at: number;
        }[];
        checkpoints: {
            name: string;
            version: number;
            source_cursor: number;
            data: string;
            updated_at: number;
        }[];
    };
    excluded: string[];
}
export interface MemoryFederatedSearch {
    mounts: string[];
    query: string;
    kind?: "records" | "sources";
    mode?: "lexical" | "hybrid";
    limit?: number;
    max_bytes?: number;
    allow_partial?: boolean;
}
export type MemoryFederatedEntry = {
    origin: {
        mount: string;
        space_id: string;
        id: string;
        version?: number;
    };
    score: number;
} & ({
    kind: "record";
    record: MemoryRecord;
} | {
    kind: "source";
    source: MemorySourceSearchResult["results"][number];
});
export interface MemoryFederatedResult {
    results: MemoryFederatedEntry[];
    failures: {
        mount: string;
        code: string;
    }[];
    incomplete: boolean;
    bytes: number;
    truncated: boolean;
    consistency: "per-peer-read-snapshots";
    replicated: false;
}
export interface MemoryFederatedRead {
    mount: string;
    id: string;
    kind: "record" | "source";
    version?: number;
    start?: number;
    end?: number;
}
export interface MemoryFederatedRetrievalResult {
    schema: "marina.memory.federated-retrieval.v1";
    evidence: (MemoryRetrievedEvidence & {
        mount: string;
    })[];
    peers: {
        mount: string;
        space_id?: string;
        status: "ok" | "truncated" | "unavailable" | "budget_exhausted";
        retrieval_generation?: number;
        vocabulary_version?: number;
        valid_at?: number;
        code?: string;
    }[];
    bytes: number;
    consistency: "per-peer";
    answer_sufficiency: "not_assessed";
    truncated: boolean;
}
export interface MemoryCachedRetrievalInput {
    retrieval: MemoryRetrievalInput & {
        valid_at: number;
    };
    mounts?: string[];
    allow_partial?: boolean;
    cache?: "read" | "read_write" | "refresh";
    ttl_ms?: number;
}
export interface MemoryCachedRetrievalResult {
    retrieval: MemoryRetrievalResult | MemoryFederatedRetrievalResult;
    cache: {
        hit: boolean;
        reason: string;
        stored?: boolean;
    };
}
```

## memory-workflows

[Source](../../src/sdk/memory-workflows.ts)

```typescript
import type { MarinaMemoryClient } from "./memory-client.js";
import type { MemoryOperationRequest } from "./memory-operations.js";
import type { MemoryRecipe, MemoryRetrievalObservation } from "./memory-recipes.js";
import type { MemoryCheckpoint, MemoryReceipt, MemoryRecord, MemoryRetrievalInput, MemoryRetrievalResult } from "./memory-types.js";
export declare const MEMORY_WORKFLOW_ACTIONS: readonly ["help", "start", "tasks", "run", "finish", "feedback", "resume", "export_episode", "import_episode", "save_recipe", "recipes", "use_recipe", "changes", "watch", "poll", "ack", "unwatch"];
export interface MemoryEvidenceReference {
    kind: "record" | "source";
    space_id: string;
    id: string;
    version?: number;
    content_hash?: string;
    text_hash?: string;
    start?: number;
    end?: number;
}
export interface MemoryEpisode {
    schema: "marina.experience.episode.v1";
    task_id: string;
    corpus: string;
    goal: string;
    next_action: string;
    status: "open" | "running" | "ready" | "completed" | "interrupted" | "failed";
    actor: string;
    executed_by?: string;
    started_at: number;
    updated_at: number;
    input?: MemoryRetrievalInput;
    attempt?: string;
    recipe?: {
        space_id: string;
        id: string;
        version: number;
    };
    elapsed_ms?: number;
    references: MemoryEvidenceReference[];
    observation?: Omit<MemoryRetrievalResult, "evidence" | "observed_candidates"> & {
        evidence: MemoryEvidenceReference[];
        observed_candidates?: MemoryEvidenceReference[];
    };
    error?: {
        code: string;
        message: string;
    };
}
export interface MemoryTaskHandle {
    goal: string;
    journal_space_id: string;
    episode_id: string;
    version: number;
    task_id: string;
    status: MemoryEpisode["status"];
    next_actions: string[];
    next_calls?: MemoryOperationRequest[];
}
export interface MemoryResumeResult extends MemoryTaskHandle {
    episode: Omit<MemoryEpisode, "observation">;
    checkpoint: MemoryCheckpoint;
    resident_checkpoint: MemoryCheckpoint | null;
    premises: {
        reference: MemoryEvidenceReference;
        current_version?: number;
        read_current?: MemoryOperationRequest;
        state: "current" | "changed" | "stale" | "unavailable" | "out_of_time";
    }[];
    retrieval?: MemoryRetrievalResult;
}
export interface MemoryChange {
    seq: number;
    operation: string;
    reference_id: string | null;
    version: number | null;
    created_at: number;
}
export interface MemoryChanges {
    space_id: string;
    events: MemoryChange[];
    cursor: number;
    high_watermark: number;
    has_more: boolean;
}
export interface MemoryWatchResult {
    name: string;
    version: number;
    changes: MemoryChanges;
    acknowledgement: {
        cursor: number;
        expected_version: number;
        observed_at: number;
    };
    temporal_due: boolean;
    next_validity_boundary: number | null;
}
export interface MemoryOutcomeInput {
    task_id: string;
    rubric: string;
    result: "helpful" | "unhelpful" | "pass" | "fail" | "unknown";
    explanation: string;
    evidence?: MemoryEvidenceReference[];
    metrics?: {
        model_calls?: number;
        input_tokens?: number;
        output_tokens?: number;
        cost_usd?: number;
        elapsed_ms?: number;
    };
}
/** Typed conveniences over the identical HTTP, MCP and resident operation vocabulary. */
export declare class MarinaMemoryWorkflows {
    readonly space: string;
    private call;
    readonly journalSpace?: string | undefined;
    constructor(space: string, call: (request: MemoryOperationRequest) => Promise<unknown>, journalSpace?: string | undefined);
    static http(client: MarinaMemoryClient, space: string, journalSpace?: string): MarinaMemoryWorkflows;
    private action;
    help(): Promise<Record<string, unknown>>;
    start(goal: string, options?: {
        task_id?: string;
        next_action?: string;
    }, key?: string): Promise<MemoryTaskHandle>;
    tasks(cursor?: string): Promise<{
        tasks: MemoryTaskHandle[];
        next_cursor: string | null;
    }>;
    run(task_id: string, expected_version: number, input?: Omit<MemoryRetrievalInput, "task">, key?: string): Promise<MemoryTaskHandle & {
        retrieval: MemoryRetrievalResult;
    }>;
    runRecipe(task_id: string, expected_version: number, id: string, version: number, key?: string): Promise<MemoryTaskHandle & {
        retrieval: MemoryRetrievalResult;
    }>;
    finish(task_id: string, expected_version: number, status: "completed" | "interrupted" | "failed", next_action: string, key?: string): Promise<MemoryTaskHandle>;
    feedback(input: MemoryOutcomeInput, key?: string): Promise<MemoryReceipt>;
    resume(task_id: string, retrieve?: boolean): Promise<MemoryResumeResult>;
    exportEpisode(task_id: string): Promise<MemoryRetrievalObservation>;
    importEpisode(observation: MemoryRetrievalObservation, options?: {
        task_id?: string;
        next_action?: string;
    }, key?: string): Promise<MemoryTaskHandle>;
    saveRecipe(recipe: MemoryRecipe, key?: string): Promise<MemoryReceipt>;
    recipes(cursor?: string): Promise<{
        results: MemoryRecord[];
        next_cursor: string | null;
    }>;
    useRecipe(id: string, version: number, task: string): Promise<MemoryRetrievalResult>;
    changes(cursor?: number, ids?: string[], limit?: number): Promise<MemoryChanges>;
    watch(name: string, ids?: string[], key?: string): Promise<MemoryReceipt>;
    poll(name: string, limit?: number): Promise<MemoryWatchResult>;
    ack(name: string, acknowledgement: number | MemoryWatchResult["acknowledgement"], cursor?: number, key?: string): Promise<MemoryReceipt>;
    unwatch(name: string, expected_version: number, key?: string): Promise<MemoryReceipt>;
}
```

## onboarding

[Source](../../src/sdk/onboarding.ts)

```typescript
export declare const ORIENTATION_COMMANDS: readonly ["look", "brief", "next"];
export interface ParticipantOrientation {
    schema: "marina.onboarding.v1";
    entity: {
        id: string;
        name: string;
    };
    room: string;
    world: string;
    objective: string | null;
    protocol: string;
    resumed: boolean;
    capabilityRevision: number;
    capabilityCommand: string;
    contextCommand: string;
    actions: {
        command: string;
        description: string;
    }[];
}
```

## protocol

[Source](../../src/sdk/protocol.ts)

```typescript
/** Opaque branded string for entity IDs */
export type EntityId = string & {
    readonly __brand: "EntityId";
};
/** Opaque branded string for room IDs (path-based, e.g. "hub/plaza") */
export type RoomId = string & {
    readonly __brand: "RoomId";
};
export declare function entityId(id: string): EntityId;
export declare function roomId(id: string): RoomId;
/**
 * Entity kinds:
 * - "agent": LLM-connected entities (user-spawned or room agents). Have WebSocket connections, autonomous loops, memory.
 * - "npc": Static room entities spawned as fallback when no LLM keys configured. Limited to hardcoded properties.
 * - "object": Inert items (not currently used for standalone entities, but reserved).
 */
export type EntityKind = "agent" | "npc" | "object";
/**
 * Typed optional fields for well-known Entity.properties keys.
 * Extends Record<string, unknown> so arbitrary keys still work.
 */
export interface KnownProperties extends Record<string, unknown> {
    rank?: number;
    role?: string;
    title?: string;
    _isFirstLogin?: boolean;
    _owner?: EntityId;
    active_modal?: string;
    code_profile?: string;
    coding_session_id?: string;
    /** Active task text for a session-bound coding agent — set on assign, cleared on stop/completion. */
    coding_task?: string;
    fragment?: string;
    ignore_list?: string[];
    /** Name of the last entity to send this one a `tell` — powers the `re` reply command. */
    last_tell_from?: string;
    /** Durable receipt id for acknowledgement/correlation when replying. */
    last_tell_id?: number;
    bookmarks?: {
        room: RoomId;
        note?: string;
    }[];
    active_quest?: string;
    completed_quests?: string[];
    quest_sectors?: string[];
    quest_note_count?: number;
    quest_look?: boolean;
    quest_move?: boolean;
    quest_say?: boolean;
    quest_examine?: boolean;
    quest_memory_set?: boolean;
    quest_note?: boolean;
    quest_recall?: boolean;
    quest_reflect?: boolean;
    quest_project_join?: boolean;
    quest_task_claim?: boolean;
    quest_task_submit?: boolean;
    quest_pool_add?: boolean;
    quest_channel_send?: boolean;
    quest_channel_join?: boolean;
    quest_predict?: boolean;
    quest_consensus?: boolean;
    quest_build?: boolean;
    quest_note_link?: boolean;
    quest_entered_workshop?: boolean;
    quest_agent_spawned?: boolean;
    quest_room_built?: boolean;
    quest_visited_creation?: boolean;
    quest_entered_bridge?: boolean;
    quest_gateway_added?: boolean;
    quest_channel_bridged?: boolean;
    quest_cross_message?: boolean;
    markets_traded?: number;
    markets_resolved?: number;
    avg_brier?: number;
    bench_navigation_best?: number;
    bench_retrieval_best?: number;
    bench_codegen_best?: number;
    bench_coordination_best?: number;
    bench_adaptation_best?: number;
    bench_memory_best?: number;
    bench_selfmod_best?: number;
    bench_collaboration_best?: number;
}
export interface Entity {
    id: EntityId;
    kind: EntityKind;
    name: string;
    short: string;
    long: string;
    room: RoomId;
    properties: KnownProperties;
    inventory: EntityId[];
    createdAt: number;
}
export type PerceptionKind = "room" | "message" | "broadcast" | "movement" | "error" | "auth_error" | "system";
export interface Perception {
    kind: PerceptionKind;
    timestamp: number;
    /** Output of one explicitly correlated WebSocket command. Ambient events omit this. */
    command_request_id?: string;
    tag?: string;
    data: Record<string, unknown>;
}
/**
 * Payload carried on `data.execApproval` of a perception sent to a coding
 * session's creator when an arbitrary (non-allowlisted) host command needs
 * interactive approval. The human replies with `code exec-approve <token>` or
 * `code exec-deny <token> [reason]`. See src/coding/exec-approver.ts.
 */
export interface ExecApprovalPrompt {
    token: string;
    argv: string[];
    cwd: string;
    rendered: string;
}
export interface RoomPerception extends Perception {
    kind: "room";
    data: {
        id: RoomId;
        short: string;
        long: string;
        items: Record<string, string>;
        exits: string[];
        entities: {
            id: EntityId;
            name: string;
            short: string;
        }[];
    };
}
export interface MessagePerception extends Perception {
    kind: "message";
    data: {
        from: EntityId;
        fromName: string;
        text: string;
    };
}
export interface BroadcastPerception extends Perception {
    kind: "broadcast";
    data: {
        text: string;
    };
}
export interface MovementPerception extends Perception {
    kind: "movement";
    data: {
        entity: EntityId;
        entityName: string;
        direction: "arrive" | "depart";
        exit?: string;
    };
}
export interface ErrorPerception extends Perception {
    kind: "error";
    data: {
        text: string;
    };
}
export interface SystemPerception extends Perception {
    kind: "system";
    data: {
        text: string;
    };
}
export type EntityRank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
```

## routing-client

[Source](../../src/sdk/routing-client.ts)

```typescript
import type { RoutingSyncInput, RoutingSyncResult, RuntimeControl, RuntimeState } from "./routing-runtime-types.js";
import type { RoutingChannelPage, RoutingChannelReceipt, RoutingEvent, RoutingEventInput, RoutingEventPage, RoutingJoin, RoutingMessage, RoutingOverview, RoutingSend, RoutingSession, RoutingSessionPage } from "./routing-types.js";
export type * from "./routing-runtime-types.js";
export type * from "./routing-types.js";
export declare class RoutingApiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
export interface RoutingClientOptions {
    url: string;
    /** Existing Marina world-account credential; never placed in the URL. */
    token: string | (() => string);
    fetch?: typeof fetch;
}
/** Generic HTTP client. It neither launches a process nor executes received messages. */
export declare class MarinaRoutingClient {
    private readonly options;
    private readonly base;
    private readonly fetcher;
    constructor(options: RoutingClientOptions);
    private request;
    join(input: RoutingJoin, signal?: AbortSignal): Promise<RoutingSession>;
    discover(after?: string, limit?: number, signal?: AbortSignal): Promise<RoutingSessionPage>;
    overview(after?: string, attention?: boolean, signal?: AbortSignal): Promise<RoutingOverview>;
    session(id: string, signal?: AbortSignal): Promise<RoutingSession>;
    heartbeat(id: string, signal?: AbortSignal): Promise<RoutingSession>;
    leave(id: string, signal?: AbortSignal): Promise<RoutingSession>;
    publish(id: string, events: RoutingEventInput[], signal?: AbortSignal): Promise<RoutingEvent[]>;
    events(id: string, after?: number, limit?: number, signal?: AbortSignal): Promise<RoutingEventPage>;
    send(id: string, input: RoutingSend, signal?: AbortSignal): Promise<RoutingMessage>;
    inbox(id: string, limit?: number, signal?: AbortSignal): Promise<RoutingMessage[]>;
    deliveries(id: string, limit?: number, signal?: AbortSignal): Promise<RoutingMessage[]>;
    receipt(id: string, messageId: string, signal?: AbortSignal): Promise<RoutingMessage>;
    acknowledge(id: string, messageId: string, signal?: AbortSignal): Promise<RoutingMessage>;
    channels(id: string, signal?: AbortSignal): Promise<{
        channels: {
            id: string;
            name: string;
        }[];
    }>;
    channelMessages(id: string, channelId: string, after?: number, limit?: number, signal?: AbortSignal): Promise<RoutingChannelPage>;
    sendChannel(id: string, channelId: string, input: {
        clientMessageId: string;
        text: string;
    }, signal?: AbortSignal): Promise<RoutingChannelReceipt>;
    sync(input: RoutingSyncInput, signal?: AbortSignal): Promise<RoutingSyncResult>;
    runtime(id: string, signal?: AbortSignal): Promise<{
        state: RuntimeState | null;
    }>;
    control(sourceId: string, targetId: string, clientMessageId: string, control: RuntimeControl, signal?: AbortSignal): Promise<RoutingMessage>;
    private path;
    /** Resumable polling subscription. Persist nextCursor after processing each page.
     * Errors surface to the consumer; retry with its last saved cursor. No hidden ack/retries.
     */
    watch(id: string, options: {
        after?: number;
        intervalMs?: number;
        signal: AbortSignal;
    }): AsyncGenerator<RoutingEventPage>;
}
```

## routing-runtime-types

[Source](../../src/sdk/routing-runtime-types.ts)

```typescript
export interface RuntimeRequest {
    id: string;
    kind: "permission" | "question";
    title: string;
    input: unknown;
    choices?: string[];
}
export interface RuntimeState {
    version: 1;
    role: "supervisor" | "agent" | "attachment";
    status: "starting" | "idle" | "running" | "waiting" | "stopped" | "failed" | "disconnected";
    mode: "managed" | "attached";
    adapter: string;
    supervisorId: string;
    cwd: string;
    nativeSessionId?: string;
    request?: RuntimeRequest;
    error?: string;
    adapters?: {
        id: string;
        label: string;
    }[];
    root?: string;
    activeCount?: number;
    updatedAt: number;
}
export type RuntimeControl = {
    action: "launch";
    adapter: string;
    label: string;
    directory?: string;
    workspace?: "worktree" | "shared";
    model?: string;
    prompt?: string;
} | {
    action: "prompt";
    text: string;
} | {
    action: "interrupt" | "stop" | "resume" | "detach";
} | {
    action: "respond";
    requestId: string;
    allow: boolean;
    answer?: string;
};
export interface RoutingSyncInput {
    publications?: {
        sessionId: string;
        events: import("./routing-types.js").RoutingEventInput[];
    }[];
    acknowledgments?: {
        sessionId: string;
        messageId: string;
    }[];
    inboxes?: string[];
}
export interface RoutingSyncResult {
    inboxes: {
        sessionId: string;
        messages: import("./routing-types.js").RoutingMessage[];
    }[];
}
```

## routing-types

[Source](../../src/sdk/routing-types.ts)

```typescript
/** Version 1: transport-neutral participants. Capabilities describe clients, not permissions. */
export interface RoutingJoin {
    clientKey: string;
    label: string;
    kind: string;
    groupId?: string;
    capabilities?: string[];
}
export interface RoutingSession {
    id: string;
    ownerId: string;
    clientKey: string;
    label: string;
    kind: string;
    groupId: string | null;
    capabilities: string[];
    state: "active" | "left";
    createdAt: number;
    lastSeenAt: number;
    lastSequence: number;
}
export interface RoutingEventInput {
    /** Stable producer id; reuse unchanged when retrying a batch. */
    id: string;
    kind: string;
    payload: unknown;
}
export interface RoutingEvent extends RoutingEventInput {
    sessionId: string;
    sequence: number;
    createdAt: number;
}
export interface RoutingEventPage {
    events: RoutingEvent[];
    nextCursor: number;
    lastSequence: number;
    hasMore: boolean;
    /** Requested history was pruned. Consumers must show this instead of implying completeness. */
    gap: boolean;
}
export interface RoutingSend {
    clientMessageId: string;
    targetId: string;
    kind: string;
    payload: unknown;
}
export interface RoutingMessage extends RoutingSend {
    id: string;
    sourceId: string;
    status: "queued" | "acknowledged";
    createdAt: number;
    acknowledgedAt: number | null;
}
export interface RoutingSessionPage {
    sessions: RoutingSession[];
    nextCursor: string | null;
}
/** Account-scoped observer projection; runtime data is reported by the participant. */
export interface RoutingOverviewItem {
    session: RoutingSession;
    runtime: unknown | null;
    lastDelivery: RoutingEvent | null;
    owned: boolean;
}
export interface RoutingOverview {
    items: RoutingOverviewItem[];
    total: number;
    nextCursor: string | null;
}
/** References to Marina's existing channel_messages; this is not a second conversation log. */
export interface RoutingChannelMessage {
    id: number;
    channelId: string;
    senderId: string;
    senderName: string;
    content: string;
    createdAt: number;
}
export interface RoutingChannelPage {
    messages: RoutingChannelMessage[];
    nextCursor: number;
    hasMore: boolean;
}
export interface RoutingChannelReceipt {
    message: RoutingChannelMessage;
    duplicate: boolean;
}
```

## score

[Source](../../src/sdk/score.ts)

```typescript
/**
 * The Score — a generated, executable workflow DAG.
 *
 * Marina's native form of the "Conductor" grammar (arXiv:2512.04388): the
 * paper's three synchronized lists (subtasks / model_id / access_list) folded
 * into one structure. A Score is a DAG of steps; each step carries an
 * instruction, an assignee, and the ids of prior steps whose outputs it may
 * read. Topology (best-of-N, chain, tree) is whatever shape the steps describe
 * — not a fixed mode.
 *
 * A Score is an artifact any sufficiently-standing agent can author, run, fork,
 * and mutate (see the conductor design (private archive: marina-internal design/conductor-design.md), Phase 4). The grammar here is pure
 * and transport-free: validation and topological layering only. Execution lives
 * in score-executor.ts with the worker-dispatch function injected, so the same
 * Score runs over tellAndAwait in production and over a mock in tests.
 */
/** How a step's assignee is addressed. */
export type AssigneeKind = "entity" | "role" | "model" | "conduct";
export interface ScoreStep {
    /** Unique within the Score. */
    id: string;
    /** Natural-language subtask handed to the worker. */
    instruction: string;
    /**
     * Who performs the step. One of:
     *   "<name>"            — a specific agent by name
     *   "role:<role>"       — resolved at run time to the best-standing live member
     *   "model:<prov/id>"   — a direct model worker
     *   "conduct"           — recursion: this step is itself conducted (sub-Score)
     */
    assignee: string;
    /** Ids of prior steps whose outputs feed this step's context. */
    access: string[];
}
export interface Score {
    id: string;
    goal: string;
    author: string;
    steps: ScoreStep[];
}
export interface ParsedAssignee {
    kind: AssigneeKind;
    /** entity name, role name, or model id; empty for "conduct". */
    value: string;
}
/** Classify an assignee string into its kind + value. */
export declare function parseAssignee(assignee: string): ParsedAssignee;
export declare class ScoreError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/**
 * Parse a Score from a JSON object/string. Fills defaults (generated id,
 * empty access lists) and normalizes shapes. Throws ScoreError on malformed
 * input. Does NOT validate the DAG — call validateScore for that.
 */
export declare function parseScore(input: string | Record<string, unknown>, defaults?: {
    author?: string;
}): Score;
export declare function serializeScore(score: Score): string;
/**
 * The step whose output is the Score's result. Per the paper, the final step
 * in sequence is the response; we take the last authored step.
 */
export declare function terminalStepId(score: Score): string | undefined;
/**
 * Validate a Score's structure. Returns an error message, or null if valid.
 * Checks: at least one step; unique non-empty ids; every step has an
 * instruction and assignee; access ids reference real steps and not self;
 * the dependency graph is acyclic.
 */
export declare function validateScore(score: Score): string | null;
/** Public layering — throws if the Score has a cycle (validate first). */
export declare function topoLayers(score: Score): ScoreStep[][];
```

## score-executor

[Source](../../src/sdk/score-executor.ts)

```typescript
import { type ParsedAssignee, type Score, type ScoreStep } from "./score.js";
/** One prior step's output, threaded into a step that accesses it. */
export interface StepInput {
    fromStepId: string;
    output: string;
}
export interface DispatchContext {
    step: ScoreStep;
    assignee: ParsedAssignee;
    inputs: StepInput[];
    /** Recursion depth of the Score this step belongs to (0 = top level). */
    depth: number;
    /** Shared cancellation: dispatchers must propagate this to their transport. */
    signal: AbortSignal;
}
/** Performs a single non-recursive step; returns the worker's output. */
export type DispatchFn = (ctx: DispatchContext) => Promise<string>;
export interface ScoreStepEvent {
    phase: "start" | "done" | "error";
    stepId: string;
    assignee: string;
    output?: string;
    error?: string;
}
export interface ExecuteOptions {
    /** Recursion cap for "conduct" steps. Default 3. */
    maxDepth?: number;
    /** Current recursion depth — set by the conduct handler, not callers. */
    depth?: number;
    /**
     * Handles a "conduct" step (recursion into a sub-Score). Receives a context
     * whose `depth` is already incremented. If absent, conduct steps error.
     */
    conduct?: (ctx: DispatchContext) => Promise<string>;
    /** Observe step lifecycle — for feed/dashboard propagation. */
    onStep?: (ev: ScoreStepEvent) => void;
    signal?: AbortSignal;
    /** Maximum active steps, default 4. Independent requests remain queued. */
    concurrency?: number;
    /** Overall deadline, including time spent waiting for predecessors. */
    timeoutMs?: number;
}
export interface ScoreRun {
    /** stepId → output. */
    outputs: Record<string, string>;
    /** The terminal (last authored) step's output — the Score's result. */
    result: string;
    /** Dispatch order (ready dependencies first, authored order breaks ties). */
    order: string[];
}
export declare function executeScore(score: Score, dispatch: DispatchFn, opts?: ExecuteOptions): Promise<ScoreRun>;
```
