// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// marina.wire.v1 — the WebSocket protocol every Marina SDK speaks, written once.
//
// This module is the source of truth: `bun run docs:api` renders it to
// `protocol/marina.wire.v1.schema.json`, the server serves it at `GET /api/protocol`,
// and `test/wire-protocol.test.ts` checks real server traffic against it. Client
// frames are closed (a typo is an error); server frames are open, because a newer
// server may add fields and a client must ignore what it does not know.

import { type Static, type TSchema, Type } from "typebox";

export const WIRE_PROTOCOL = "marina.wire.v1";
/** Where a running server serves this schema. */
export const WIRE_SCHEMA_PATH = "/api/protocol";
export const WIRE_SCHEMA_ID = "https://marina.h2o.ai/protocol/marina.wire.v1.schema.json";

const open = { additionalProperties: true } as const;
const closed = { additionalProperties: false } as const;

// ─── Client → server ─────────────────────────────────────────────────────────

const Principal = Type.Union([Type.Literal("agent"), Type.Literal("person")], {
  description:
    "Who is at the keyboard. `agent` (the SDK default) can never approve another's held action; `person` is a human at a terminal.",
});
const ModelName = Type.String({
  pattern: "^[\\w./:@-]{1,120}$",
  description: "The model this participant runs on, shown to others. Omit when not a model.",
});

export const LoginFrame = Type.Object(
  {
    type: Type.Literal("login"),
    name: Type.String({
      minLength: 2,
      maxLength: 20,
      pattern: "^[A-Za-z0-9]+$",
      description: "Your name in the world: 2-20 letters or digits.",
    }),
    principal: Type.Optional(Principal),
    model: Type.Optional(ModelName),
    internalToken: Type.Optional(
      Type.String({ description: "A workload credential issued by this server, if you hold one." }),
    ),
  },
  { ...closed, title: "Login", description: "Enter the world under a name. First frame you send." },
);

export const AuthFrame = Type.Object(
  {
    type: Type.Literal("auth"),
    token: Type.String({
      minLength: 1,
      description:
        "The session token from your last login or auth reply. It is single-use: the reply carries a new one.",
    }),
    principal: Type.Optional(Principal),
    model: Type.Optional(ModelName),
    internalToken: Type.Optional(Type.String()),
  },
  {
    ...closed,
    title: "Auth",
    description:
      "Resume a session after a disconnect. Within 60 s of the drop you get the same entity back.",
  },
);

const CodingTarget = Type.Object(
  {
    sessionId: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,128}$" }),
    runId: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,128}$" })),
  },
  {
    ...closed,
    description:
      "Aim a `code …` command at one coding session (and run). Needs `codingTargetProtocol: session-run-v1`.",
  },
);

export const CommandFrame = Type.Object(
  {
    type: Type.Literal("command"),
    command: Type.String({
      description:
        "One command line, exactly as a person would type it: `look`, `code do fix the bug`.",
    }),
    request_id: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        description:
          "Your id for this command. Every frame it produces carries it as `command_request_id`, and it ends with exactly one `command_result`. Always send one.",
      }),
    ),
    coding_target: Type.Optional(CodingTarget),
    cause: Type.Optional(
      Type.String({
        description:
          "The message this command answers (`tell:12`, `channel_msg:4`). Kept only if it was delivered to you.",
      }),
    ),
    trace_links: Type.Optional(
      Type.Array(
        Type.Object(
          {
            traceId: Type.String({ minLength: 1, maxLength: 200 }),
            spanId: Type.String({ minLength: 1, maxLength: 200 }),
          },
          closed,
        ),
        { maxItems: 32 },
      ),
    ),
  },
  { ...closed, title: "Command", description: "Run one command." },
);

export const CapabilitiesFrame = Type.Object(
  {
    type: Type.Literal("capabilities"),
    request_id: Type.String({ minLength: 1, maxLength: 100 }),
    capability_key: Type.Optional(
      Type.String({
        description:
          "The `key` of a manifest you already hold; the reply says `unchanged` if it still matches.",
      }),
    ),
  },
  {
    ...closed,
    title: "Capabilities",
    description:
      "Ask for every command you can run, with typed forms and JSON Schemas. Reply: a `capabilities` frame.",
  },
);

export const ContextPreviewFrame = Type.Object(
  {
    type: Type.Literal("context_preview"),
    request_id: Type.String({ minLength: 1, maxLength: 100 }),
    options: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 4000 }),
        budgetBytes: Type.Optional(Type.Integer({ minimum: 256, maximum: 16384, default: 4096 })),
        scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("evidence")])),
        warm: Type.Optional(Type.Literal(true)),
        skipTiers: Type.Optional(
          Type.Array(Type.Union([Type.Literal("evidence"), Type.Literal("proposal")])),
        ),
      },
      closed,
    ),
  },
  {
    ...closed,
    title: "Context preview",
    description:
      "See what Marina's memory would put in front of you for a query, within a byte budget.",
  },
);

export const PingFrame = Type.Object(
  { type: Type.Literal("ping") },
  {
    ...closed,
    title: "Ping",
    description:
      "Keep an idle connection open (the server closes a connection silent for 255 s). No reply.",
  },
);

export const ClientFrame = Type.Union(
  [LoginFrame, AuthFrame, CommandFrame, CapabilitiesFrame, ContextPreviewFrame, PingFrame],
  { title: "Client frame", description: "Any frame a client sends: one JSON object per message." },
);

// ─── Server → client ─────────────────────────────────────────────────────────

export const FrameKind = Type.Union(
  [
    Type.Literal("message"),
    Type.Literal("system"),
    Type.Literal("error"),
    Type.Literal("auth_error"),
    Type.Literal("room"),
    Type.Literal("broadcast"),
    Type.Literal("movement"),
  ],
  {
    description:
      "`message` world output, `system` protocol and session notices, `error` a refusal, `auth_error` login refused (forget the token). The last three are reserved; today's servers send them as `message`.",
  },
);

const TraceLink = Type.Object({ traceId: Type.String(), spanId: Type.String() }, open);

/** Every server frame: an envelope around `data`. Look at `tag` and `data` to tell them apart. */
export const ServerFrame = Type.Object(
  {
    kind: FrameKind,
    timestamp: Type.Number({ description: "Milliseconds since the Unix epoch." }),
    command_request_id: Type.Optional(
      Type.String({ description: "The `request_id` of the command that produced this frame." }),
    ),
    tag: Type.Optional(
      Type.String({
        description:
          "What the frame is about: `code`, `tell`, `say`, `capabilities`, `onboarding`, …",
      }),
    ),
    data: Type.Object(
      {
        text: Type.Optional(
          Type.String({
            description: "Human-readable rendering. Safe to print; never needed to parse.",
          }),
        ),
        traceLinks: Type.Optional(Type.Array(TraceLink)),
      },
      open,
    ),
  },
  { ...open, title: "Server frame" },
);

function frame<T extends TSchema>(
  kind: "system" | "message" | "error" | "auth_error",
  data: T,
  opts: { tag?: string; title: string; description: string },
) {
  return Type.Object(
    {
      kind: Type.Literal(kind),
      timestamp: Type.Number(),
      command_request_id: Type.Optional(Type.String()),
      ...(opts.tag ? { tag: Type.Literal(opts.tag) } : { tag: Type.Optional(Type.String()) }),
      data,
    },
    { ...open, title: opts.title, description: opts.description },
  );
}

export const WelcomeFrame = frame(
  "system",
  Type.Object(
    {
      text: Type.String(),
      protocol: Type.Literal(WIRE_PROTOCOL),
      schema: Type.String({ description: "Path of this schema on the server." }),
      skill: Type.String(),
      connect: Type.String(),
    },
    open,
  ),
  {
    title: "Welcome",
    description: "Sent as soon as the socket opens. Reply with `login` or `auth`.",
  },
);

export const SessionFrame = frame(
  "system",
  Type.Object(
    {
      text: Type.String(),
      entityId: Type.String({ description: "Your entity id in the world." }),
      name: Type.String(),
      token: Type.String({
        description:
          "Session token for `auth` after a disconnect. Store the newest one; each is single-use.",
      }),
      protocol: Type.Literal(WIRE_PROTOCOL),
      commandProtocol: Type.Literal("correlated-v1"),
      worldCommandProtocol: Type.Optional(Type.Literal("slash-v1")),
      codingTargetProtocol: Type.Optional(Type.Literal("session-run-v1")),
      activeEvolutionSessions: Type.Optional(
        Type.Array(Type.Object({ id: Type.String(), experimentId: Type.String() }, open)),
      ),
    },
    open,
  ),
  {
    title: "Session",
    description: "Login or auth succeeded. A `system` frame whose data has `entityId`.",
  },
);

export const AuthErrorFrame = frame("auth_error", Type.Object({ text: Type.String() }, open), {
  title: "Auth error",
  description:
    "Login or auth refused (name taken, invalid name, rate limited, token expired). Drop the token; the socket stays open.",
});

export const CommandResultFrame = frame(
  "system",
  Type.Object(
    {
      command_result: Type.Object(
        {
          request_id: Type.String(),
          ok: Type.Boolean({
            description: "false: the command was refused or failed. Its frames say why.",
          }),
          error: Type.Optional(Type.String()),
        },
        open,
      ),
    },
    open,
  ),
  {
    title: "Command result",
    description:
      "Exactly one per command sent with a `request_id`, after all of its output. The command is over.",
  },
);

export const ErrorFrame = frame(
  "error",
  Type.Object(
    {
      text: Type.String(),
      code: Type.Optional(
        Type.String({ description: "Machine-readable reason, e.g. `command_overloaded`." }),
      ),
      retryable: Type.Optional(Type.Boolean()),
      executed: Type.Optional(
        Type.Boolean({ description: "false: the command never ran, so it is safe to resend." }),
      ),
    },
    open,
  ),
  {
    title: "Error",
    description: "A refusal. Inside a command it also makes that command's result `ok: false`.",
  },
);

export const CapabilitiesReplyFrame = frame(
  "system",
  Type.Object(
    {
      capabilities: Type.Object(
        {
          schema: Type.Optional(Type.Literal("marina.capabilities.v1")),
          request_id: Type.String(),
          revision: Type.Optional(Type.Number()),
          key: Type.Optional(Type.String()),
          unchanged: Type.Optional(Type.Literal(true)),
          commands: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  name: Type.String(),
                  aliases: Type.Array(Type.String()),
                  category: Type.String(),
                  help: Type.String(),
                  minRank: Type.Number(),
                },
                open,
              ),
              {
                description:
                  "Every command, each with `forms`: its syntax and an `inputSchema` (JSON Schema) for typed calls.",
              },
            ),
          ),
          error: Type.Optional(Type.String()),
        },
        open,
      ),
    },
    open,
  ),
  { tag: "capabilities", title: "Capabilities reply", description: "Answer to `capabilities`." },
);

export const ContextPreviewReplyFrame = frame(
  "system",
  Type.Object(
    {
      context_preview: Type.Object(
        {
          schema: Type.Optional(Type.Literal("marina.context.preview.v1")),
          request_id: Type.String(),
          createdAt: Type.Optional(Type.Number()),
          context: Type.Optional(Type.Object({}, open)),
          error: Type.Optional(Type.String()),
        },
        open,
      ),
    },
    open,
  ),
  {
    tag: "context_preview",
    title: "Context preview reply",
    description: "Answer to `context_preview`.",
  },
);

export const MemoryServiceFrame = frame(
  "message",
  Type.Object(
    {
      memory_service: Type.Union([
        Type.Object(
          {
            ok: Type.Literal(true),
            result: Type.Unknown(),
            space_id: Type.Optional(Type.String()),
            request_id: Type.Optional(Type.String()),
          },
          open,
        ),
        Type.Object(
          {
            ok: Type.Literal(false),
            request_id: Type.Optional(Type.String()),
            error: Type.Object(
              {
                code: Type.String(),
                message: Type.String(),
                status: Type.Optional(Type.Number()),
                retry_after_ms: Type.Optional(Type.Number()),
              },
              open,
            ),
          },
          open,
        ),
      ]),
    },
    open,
  ),
  {
    title: "Memory service reply",
    description:
      "Answer to the command `memory api {json}`, matched by the JSON's `request_id` (see the memory guide).",
  },
);

export const TellFrame = frame(
  "message",
  Type.Object(
    {
      text: Type.String(),
      senderName: Type.Optional(Type.String()),
      senderKind: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("person")])),
      message: Type.Optional(Type.String()),
      messageRef: Type.Optional(
        Type.String({
          description: "Pass as a command's `cause` when you answer it, e.g. `tell:12`.",
        }),
      ),
      correlationId: Type.Optional(Type.String()),
      deadlineAt: Type.Optional(Type.Number()),
    },
    open,
  ),
  {
    tag: "tell",
    title: "Tell",
    description: "A direct message to you (or the echo of one you sent).",
  },
);

// ─── Coding ──────────────────────────────────────────────────────────────────

export const CodingActivity = Type.Object(
  {
    kind: Type.Union(
      ["read", "search", "edit", "write", "patch", "run", "verify", "plan", "summary", "other"].map(
        (k) => Type.Literal(k),
      ),
    ),
    label: Type.String({ description: 'One line in plain words: "Edit paginate.js".' }),
    path: Type.Optional(Type.String()),
    diff: Type.Optional(
      Type.Array(Type.String(), {
        description: "The change, as unified-diff body lines (`-old`, `+new`, ` context`), capped.",
      }),
    ),
    more: Type.Optional(Type.Integer({ description: "Diff lines left out past the cap." })),
    quiet: Type.Optional(Type.Boolean({ description: "Bookkeeping; a UI may hide it." })),
  },
  { ...open, title: "Coding activity", description: "One step the coder took." },
);

export const Verification = Type.Union(
  ["passed", "failed", "not_run", "error", "missing", "stale", "unbound", "unavailable"].map((v) =>
    Type.Literal(v),
  ),
  { description: "What the checks said. Only `passed` means checks ran on the change and passed." },
);

export const RunResult = Type.Object(
  {
    runId: Type.String(),
    taskId: Type.Optional(Type.Number()),
    agent: Type.Optional(Type.String()),
    terminal: Type.Literal(true),
    phase: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
    outcome: Type.Optional(
      Type.Union(
        ["submitted", "failed", "cancelled", "interrupted"].map((o) => Type.Literal(o)),
        {
          description: "`submitted`: the coder finished and handed the change in for review.",
        },
      ),
    ),
    reason: Type.Optional(Type.String({ description: "`blocked`, `agent_died`, or free text." })),
    detail: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    summaryId: Type.Optional(Type.String()),
    verification: Type.Optional(Verification),
    verificationReason: Type.Optional(Type.String()),
    budgetForced: Type.Optional(
      Type.Object(
        {
          reason: Type.String(),
          used: Type.Optional(Type.Number()),
          cap: Type.Optional(Type.Number()),
        },
        { ...open, description: "Present when a budget forced the answer; never a free answer." },
      ),
    ),
  },
  {
    ...open,
    title: "Run result",
    description: "How a coding run ended. Review it with `code review approve|reject <runId>`.",
  },
);

const CodeMetadata = Type.Object(
  {
    event: Type.String({
      description:
        "What happened: `agent_output` (a step or the coder's words), `code_lifecycle` (session or run state; a run's end carries a Run result), `verification_finished`, …",
    }),
    type: Type.String({
      description:
        "Payload shape: `stream`, `lifecycle`, `diff`, `file`, `verification`, `list`, …",
    }),
    sessionId: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    artifactId: Type.Optional(Type.String()),
    artifactKind: Type.Optional(Type.String()),
    content: Type.Optional(Type.String()),
    paths: Type.Optional(Type.Array(Type.String())),
    commands: Type.Optional(Type.Array(Type.String())),
    checks: Type.Optional(
      Type.Array(
        Type.Object(
          {
            label: Type.String(),
            status: Type.Union(["fail", "info", "ok", "warn"].map((s) => Type.Literal(s))),
            detail: Type.Optional(Type.String()),
          },
          open,
        ),
      ),
    ),
    metadata: Type.Optional(
      Type.Object(
        {
          agent: Type.Optional(Type.String()),
          kind: Type.Optional(
            Type.Union(
              ["tool", "prose", "tool_error", "error"].map((k) => Type.Literal(k)),
              {
                description:
                  "On `agent_output`: a step (`tool`), the coder's words (`prose`), or a failure.",
              },
            ),
          ),
          activity: Type.Optional(CodingActivity),
        },
        { ...open, description: "Event detail. A run's end puts its Run result here." },
      ),
    ),
  },
  open,
);

export const CodeFrame = frame(
  "message",
  Type.Object({ text: Type.String(), code: CodeMetadata }, open),
  {
    tag: "code",
    title: "Code event",
    description:
      "Coding session output: steps, edits with their diffs, checks, and how a run ended.",
  },
);

export const ExecApprovalFrame = frame(
  "message",
  Type.Object(
    {
      text: Type.String(),
      execApproval: Type.Object(
        {
          token: Type.String(),
          argv: Type.Array(Type.String()),
          cwd: Type.String(),
          rendered: Type.String(),
        },
        open,
      ),
    },
    open,
  ),
  {
    tag: "code",
    title: "Exec approval",
    description:
      "The coder wants to run a command outside the allowlist. Answer `code exec-approve <token>` or `code exec-deny <token> [reason]`.",
  },
);

export const OnboardingFrame = frame(
  "message",
  Type.Object(
    {
      text: Type.String(),
      onboarding: Type.Object(
        {
          schema: Type.Literal("marina.onboarding.v1"),
          entity: Type.Object({ id: Type.String(), name: Type.String() }, open),
          actions: Type.Optional(
            Type.Array(Type.Object({ command: Type.String(), description: Type.String() }, open)),
          ),
        },
        open,
      ),
    },
    open,
  ),
  {
    tag: "onboarding",
    title: "Onboarding",
    description: "Right after login: where you are and the first commands worth running.",
  },
);

/** Well-known server frames, most specific first. Anything else is a plain Server frame. */
export const KNOWN_SERVER_FRAMES = {
  Welcome: WelcomeFrame,
  Session: SessionFrame,
  AuthError: AuthErrorFrame,
  CommandResult: CommandResultFrame,
  Error: ErrorFrame,
  CapabilitiesReply: CapabilitiesReplyFrame,
  ContextPreviewReply: ContextPreviewReplyFrame,
  MemoryService: MemoryServiceFrame,
  ExecApproval: ExecApprovalFrame,
  Code: CodeFrame,
  Tell: TellFrame,
  Onboarding: OnboardingFrame,
} as const;

export const KNOWN_CLIENT_FRAMES = {
  Login: LoginFrame,
  Auth: AuthFrame,
  Command: CommandFrame,
  Capabilities: CapabilitiesFrame,
  ContextPreview: ContextPreviewFrame,
  Ping: PingFrame,
} as const;

export type KnownServerFrame = keyof typeof KNOWN_SERVER_FRAMES;

/**
 * Which well-known frame this is, by the documented dispatch rule (protocol/README.md,
 * "Telling frames apart"); `Output` is ordinary world output. Every SDK uses this order.
 */
export function classifyServerFrame(frame: {
  kind?: unknown;
  tag?: unknown;
  data?: unknown;
}): KnownServerFrame | "Output" {
  const data = (frame.data ?? {}) as Record<string, unknown>;
  if (frame.kind === "auth_error") return "AuthError";
  if (frame.kind === "error") return "Error";
  if (data.command_result) return "CommandResult";
  if (frame.kind === "system" && typeof data.entityId === "string") return "Session";
  if (frame.kind === "system" && data.protocol && data.schema) return "Welcome";
  if (frame.tag === "capabilities") return "CapabilitiesReply";
  if (frame.tag === "context_preview") return "ContextPreviewReply";
  if (data.memory_service) return "MemoryService";
  if (data.execApproval) return "ExecApproval";
  if (data.code) return "Code";
  if (frame.tag === "tell") return "Tell";
  if (frame.tag === "onboarding") return "Onboarding";
  return "Output";
}

export type ClientFrame = Static<typeof ClientFrame>;
export type ServerFrame = Static<typeof ServerFrame>;
export type RunResult = Static<typeof RunResult>;
export type CodingActivity = Static<typeof CodingActivity>;

/** The whole protocol as one JSON Schema (2020-12) document. */
export function wireProtocolSchema(): Record<string, unknown> {
  const defs: Record<string, unknown> = {
    ClientFrame: refUnion(Object.keys(KNOWN_CLIENT_FRAMES), "Any frame a client sends."),
    ServerFrame,
    CodingActivity,
    RunResult,
    Verification,
  };
  for (const [name, schema] of Object.entries(KNOWN_CLIENT_FRAMES)) defs[name] = schema;
  for (const [name, schema] of Object.entries(KNOWN_SERVER_FRAMES)) defs[name] = schema;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: WIRE_SCHEMA_ID,
    title: WIRE_PROTOCOL,
    description:
      "Marina's WebSocket protocol. Connect to ws(s)://<host>/ws, send ClientFrame objects as JSON text, receive ServerFrame objects. Every server frame is a ServerFrame; the other server definitions name the well-known ones. Guide: protocol/README.md.",
    $defs: JSON.parse(JSON.stringify(defs)),
  };
}

function refUnion(names: string[], description: string) {
  return { description, oneOf: names.map((n) => ({ $ref: `#/$defs/${n}` })) };
}
