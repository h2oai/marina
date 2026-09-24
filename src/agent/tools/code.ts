// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Code Mode tools: the action-enum `marina_code` tool, the typed
// `marina_code_*` wrappers and the command builders / single-line parameter
// guards they share.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { execCommand, type ToolContext, wrap } from "./shared";

const codeSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("status"),
      Type.Literal("files"),
      Type.Literal("read"),
      Type.Literal("search"),
      Type.Literal("diff"),
      Type.Literal("run"),
      Type.Literal("verify"),
      Type.Literal("observe"),
      Type.Literal("patch"),
      Type.Literal("apply"),
      Type.Literal("reject"),
      Type.Literal("show"),
      Type.Literal("patches"),
      Type.Literal("artifacts"),
      Type.Literal("history"),
      Type.Literal("plan"),
      Type.Literal("summary"),
      Type.Literal("handoff"),
      Type.Literal("decision"),
      Type.Literal("workspace"),
      Type.Literal("doctor"),
      Type.Literal("recipe"),
      Type.Literal("checkpoint"),
      Type.Literal("revert"),
      Type.Literal("approval"),
      Type.Literal("approve"),
      Type.Literal("deny"),
      Type.Literal("model"),
      Type.Literal("skill"),
      Type.Literal("thread"),
      Type.Literal("crew"),
      Type.Literal("roles"),
      Type.Literal("external"),
    ],
    {
      description:
        "Coding action. Assigned agents normally have an active coding session already bound.",
    },
  ),
  path: Type.Optional(Type.String({ description: "Relative workspace path for files/read/diff" })),
  query: Type.Optional(Type.String({ description: "Search query for action=search" })),
  command: Type.Optional(
    Type.String({
      description:
        "Allowed command for action=run, or workspace subcommand for action=workspace: show, list, or use",
    }),
  ),
  title: Type.Optional(Type.String({ description: "Artifact title for action=patch" })),
  diff: Type.Optional(Type.String({ description: "Unified diff for action=patch" })),
  artifactId: Type.Optional(
    Type.String({ description: "Artifact id for action=apply/reject/show" }),
  ),
  kind: Type.Optional(Type.String({ description: "Artifact kind filter for action=artifacts" })),
  status: Type.Optional(
    Type.String({
      description: "Patch status filter for action=patches: pending, applied, rejected",
    }),
  ),
  text: Type.Optional(
    Type.String({ description: "Text for plan/summary/handoff/decision/observe/reject" }),
  ),
});

const codeEmptySchema = Type.Object({});

const codePathSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Relative workspace path" })),
});

const codeReadFileSchema = Type.Object({
  path: Type.String({ description: "Relative workspace file path" }),
});

const codeSearchSchema = Type.Object({
  query: Type.String({ description: "Search query" }),
});

const codeRunSchema = Type.Object({
  command: Type.String({
    description: "Allowed workspace command, for example test or git status --short",
  }),
});

const codePatchSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "Patch artifact title" })),
  diff: Type.String({ description: "Unified diff to propose" }),
});

const codeEditSchema = Type.Object({
  path: Type.String({ description: "Relative workspace file path" }),
  oldText: Type.String({ description: "Exact existing text to replace (may span lines)" }),
  newText: Type.String({ description: "Replacement text (empty string deletes oldText)" }),
  replaceAll: Type.Optional(
    Type.Boolean({ description: "Replace every occurrence instead of requiring a unique match" }),
  ),
});

const codeWriteSchema = Type.Object({
  path: Type.String({ description: "Relative workspace file path" }),
  content: Type.String({ description: "Full file content to write" }),
});

const codeArtifactsSchema = Type.Object({
  kind: Type.Optional(Type.String({ description: "Artifact kind filter" })),
});

const codePatchRefSchema = Type.Object({
  artifactId: Type.String({ description: "Patch or artifact id" }),
});

const codeRejectPatchSchema = Type.Object({
  artifactId: Type.String({ description: "Patch artifact id" }),
  text: Type.Optional(Type.String({ description: "Optional rejection reason" })),
});

const codeTextSchema = Type.Object({
  text: Type.String({ description: "Single-line note text" }),
});

const codeHistorySchema = Type.Object({
  sessionId: Type.Optional(Type.String({ description: "Optional coding session id" })),
});

const codeWorkspaceSchema = Type.Object({
  command: Type.Optional(
    Type.Union([Type.Literal("show"), Type.Literal("list"), Type.Literal("use")], {
      description: "Workspace action: show, list, or use",
    }),
  ),
  path: Type.Optional(Type.String({ description: "Workspace path/name for command=use" })),
});

const codeRecipeSchema = Type.Object({
  command: Type.Union([Type.Literal("list"), Type.Literal("save"), Type.Literal("run")]),
  name: Type.Optional(Type.String({ description: "Recipe name" })),
  text: Type.Optional(Type.String({ description: "Commands separated by then" })),
});

const codeCheckpointSchema = Type.Object({
  command: Type.Union([Type.Literal("create"), Type.Literal("revert")]),
  title: Type.Optional(Type.String({ description: "Checkpoint title" })),
  artifactId: Type.Optional(Type.String({ description: "Checkpoint artifact id for revert" })),
});

const codeApprovalSchema = Type.Object({
  command: Type.Union([
    Type.Literal("list"),
    Type.Literal("request"),
    Type.Literal("approve"),
    Type.Literal("deny"),
  ]),
  kind: Type.Optional(Type.String({ description: "Approval kind for request" })),
  text: Type.Optional(Type.String({ description: "Approval description" })),
  artifactId: Type.Optional(Type.String({ description: "Approval artifact id" })),
});

const codeModelSchema = Type.Object({
  command: Type.Union([Type.Literal("show"), Type.Literal("set"), Type.Literal("clear")]),
  target: Type.Optional(Type.String({ description: "Model/provider/agent/crew target" })),
});

const codeSkillSchema = Type.Object({
  command: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("use")]),
  name: Type.Optional(Type.String({ description: "Skill name" })),
  text: Type.Optional(Type.String({ description: "Skill instructions" })),
});

const codeExternalSchema = Type.Object({
  command: Type.Union([Type.Literal("show"), Type.Literal("link"), Type.Literal("unlink")]),
  system: Type.Optional(Type.String({ description: "External system name" })),
  externalId: Type.Optional(Type.String({ description: "External session id" })),
  artifactId: Type.Optional(Type.String({ description: "External link artifact id" })),
});

export function createCodeTool(ctx: ToolContext): AgentTool<typeof codeSchema> {
  return {
    name: "marina_code",
    label: "Code",
    description:
      "Work inside the active Marina coding session: inspect files, read, search, diff, run allowed checks, propose/apply patches, and record durable coding artifacts.",
    parameters: codeSchema,
    execute: async (_id, params: Static<typeof codeSchema>, signal) => {
      try {
        return await execCommand(ctx, buildCodeCommand(params), signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Invalid marina_code request: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

export function createTypedCodeTools(ctx: ToolContext): AgentTool[] {
  return [
    wrap(
      "marina_code_session_status",
      "Code Session Status",
      "Show the active Marina coding session, workspace, latest artifact, and pending patches.",
      codeEmptySchema,
      () => "code status",
      ctx,
    ),
    wrap(
      "marina_code_list_files",
      "Code List Files",
      "List files in the active coding session workspace.",
      codePathSchema,
      (p) => `code files ${singleLineCodeParam((p.path as string | undefined) ?? ".", "path")}`,
      ctx,
    ),
    wrap(
      "marina_code_read_file",
      "Code Read File",
      "Read one relative file from the active coding session workspace.",
      codeReadFileSchema,
      (p) =>
        `code read ${requiredSingleLineCodeParam(p.path as string | undefined, "path", "path is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_search",
      "Code Search",
      "Search text in the active coding session workspace.",
      codeSearchSchema,
      (p) =>
        `code search ${requiredSingleLineCodeParam(p.query as string | undefined, "query", "query is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_diff",
      "Code Diff",
      "Show git diff for the active coding session workspace, optionally scoped to a path.",
      codePathSchema,
      (p) => (p.path ? `code diff ${singleLineCodeParam(p.path as string, "path")}` : "code diff"),
      ctx,
    ),
    wrap(
      "marina_code_run",
      "Code Run",
      "Run one allowed workspace command and store the command-output artifact.",
      codeRunSchema,
      (p) =>
        `code run ${requiredSingleLineCodeParam(p.command as string | undefined, "command", "command is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_verify",
      "Code Verify",
      "Run the detected verification chain and store a verification artifact.",
      codeEmptySchema,
      () => "code verify",
      ctx,
    ),
    wrap(
      "marina_code_artifacts",
      "Code Artifacts",
      "List coding artifacts for the active session, optionally filtered by kind.",
      codeArtifactsSchema,
      (p) =>
        p.kind
          ? `code artifacts kind ${singleLineCodeParam(p.kind as string, "kind")}`
          : "code artifacts",
      ctx,
    ),
    wrap(
      "marina_code_patch",
      "Code Patch",
      "Propose a unified-diff patch artifact in the active coding session.",
      codePatchSchema,
      (p) =>
        `code patch ${singleLineCodeParam((p.title as string | undefined) ?? "Proposed change", "title")}\n${requiredCodeDiff(p.diff as string | undefined)}`,
      ctx,
    ),
    wrap(
      "marina_code_edit",
      "Code Edit",
      "Surgically replace exact text in one workspace file. Prefer this over patches for small targeted changes; if a patch fails to apply, fall back to this instead of retrying the same diff. oldText must match the file byte-for-byte (copy it from marina_code_read_file, including whitespace); set replaceAll only when every occurrence should change.",
      codeEditSchema,
      (p) => {
        const path = requiredSingleLineCodeParam(
          p.path as string | undefined,
          "path",
          "path is required",
        );
        const oldText = p.oldText as string | undefined;
        if (!oldText) throw new Error("oldText is required");
        const newText = (p.newText as string | undefined) ?? "";
        const all = p.replaceAll === true ? " all" : "";
        return `code edit ${path}${all}\n<<<<<<< OLD\n${oldText}\n=======\n${newText}\n>>>>>>> NEW`;
      },
      ctx,
    ),
    wrap(
      "marina_code_write",
      "Code Write",
      "Create or fully overwrite one workspace file with the given content (parent directories are created). Use for new files or full rewrites; prefer marina_code_edit for surgical changes to existing files.",
      codeWriteSchema,
      (p) => {
        const path = requiredSingleLineCodeParam(
          p.path as string | undefined,
          "path",
          "path is required",
        );
        const content = p.content as string | undefined;
        if (content == null) throw new Error("content is required");
        return `code write ${path}\n${content}`;
      },
      ctx,
    ),
    wrap(
      "marina_code_apply_patch",
      "Code Apply Patch",
      "Apply a pending patch artifact in the active coding session.",
      codePatchRefSchema,
      (p) =>
        `code apply ${requiredSingleLineCodeParam(p.artifactId as string | undefined, "artifactId", "artifactId is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_reject_patch",
      "Code Reject Patch",
      "Reject a pending patch artifact in the active coding session.",
      codeRejectPatchSchema,
      (p) =>
        `code reject ${requiredSingleLineCodeParam(
          p.artifactId as string | undefined,
          "artifactId",
          "artifactId is required",
        )}${
          typeof p.text === "string" && p.text.trim()
            ? ` ${singleLineCodeParam(p.text, "text")}`
            : ""
        }`,
      ctx,
    ),
    wrap(
      "marina_code_observe",
      "Code Observe",
      "Store an app or workspace observation artifact in the active coding session.",
      codeTextSchema,
      (p) =>
        `code observe ${requiredSingleLineCodeParam(p.text as string | undefined, "text", "text is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_plan",
      "Code Plan",
      "Store a plan artifact in the active coding session.",
      codeTextSchema,
      (p) =>
        `code plan ${requiredSingleLineCodeParam(p.text as string | undefined, "text", "text is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_summary",
      "Code Summary",
      "Store a summary artifact in the active coding session.",
      codeTextSchema,
      (p) =>
        `code summary ${requiredSingleLineCodeParam(p.text as string | undefined, "text", "text is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_handoff",
      "Code Handoff",
      "Store a handoff artifact in the active coding session.",
      codeTextSchema,
      (p) =>
        `code handoff ${requiredSingleLineCodeParam(p.text as string | undefined, "text", "text is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_decision",
      "Code Decision",
      "Store a decision artifact in the active coding session.",
      codeTextSchema,
      (p) =>
        `code decision ${requiredSingleLineCodeParam(p.text as string | undefined, "text", "text is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_history",
      "Code History",
      "Show recent coding events for the active or specified coding session.",
      codeHistorySchema,
      (p) =>
        p.sessionId
          ? `code history ${singleLineCodeParam(p.sessionId as string, "sessionId")}`
          : "code history",
      ctx,
    ),
    wrap(
      "marina_code_workspace",
      "Code Workspace",
      "Show, list, or select the active coding workspace.",
      codeWorkspaceSchema,
      (p) => {
        if (p.command === "list") return "code workspace list";
        if (p.command === "use") {
          return `code workspace use ${requiredSingleLineCodeParam(
            p.path as string | undefined,
            "path",
            "path is required",
          )}`;
        }
        return "code workspace";
      },
      ctx,
    ),
    wrap(
      "marina_code_doctor",
      "Code Doctor",
      "Diagnose Code Mode setup for the current entity and workspace.",
      codeEmptySchema,
      () => "code doctor",
      ctx,
    ),
    wrap(
      "marina_code_recipe",
      "Code Recipe",
      "List, save, or run Code Mode verification recipes.",
      codeRecipeSchema,
      (p) => {
        if (p.command === "save") {
          return `code recipe save ${requiredSingleLineCodeParam(
            p.name as string | undefined,
            "name",
            "name is required",
          )} ${requiredSingleLineCodeParam(
            p.text as string | undefined,
            "text",
            "text is required",
          )}`;
        }
        if (p.command === "run") {
          return `code recipe run ${requiredSingleLineCodeParam(
            p.name as string | undefined,
            "name",
            "name is required",
          )}`;
        }
        return "code recipe list";
      },
      ctx,
    ),
    wrap(
      "marina_code_checkpoint",
      "Code Checkpoint",
      "Create or revert a workspace diff checkpoint in the active coding session.",
      codeCheckpointSchema,
      (p) => {
        if (p.command === "revert") {
          return `code revert ${requiredSingleLineCodeParam(
            p.artifactId as string | undefined,
            "artifactId",
            "artifactId is required",
          )}`;
        }
        return p.title
          ? `code checkpoint ${singleLineCodeParam(p.title as string, "title")}`
          : "code checkpoint";
      },
      ctx,
    ),
    wrap(
      "marina_code_approval",
      "Code Approval",
      "Create or decide Code Mode approval artifacts.",
      codeApprovalSchema,
      (p) => {
        if (p.command === "request") {
          return `code approval request ${requiredSingleLineCodeParam(
            p.kind as string | undefined,
            "kind",
            "kind is required",
          )} ${requiredSingleLineCodeParam(
            p.text as string | undefined,
            "text",
            "text is required",
          )}`;
        }
        if (p.command === "approve") {
          return `code approve ${requiredSingleLineCodeParam(
            p.artifactId as string | undefined,
            "artifactId",
            "artifactId is required",
          )}`;
        }
        if (p.command === "deny") {
          return `code deny ${requiredSingleLineCodeParam(
            p.artifactId as string | undefined,
            "artifactId",
            "artifactId is required",
          )}`;
        }
        return "code approvals";
      },
      ctx,
    ),
    wrap(
      "marina_code_model",
      "Code Model",
      "Show or set the per-session code model/provider target.",
      codeModelSchema,
      (p) => {
        if (p.command === "set") {
          return `code model set ${requiredSingleLineCodeParam(
            p.target as string | undefined,
            "target",
            "target is required",
          )}`;
        }
        if (p.command === "clear") return "code model clear";
        return "code model";
      },
      ctx,
    ),
    wrap(
      "marina_code_skill",
      "Code Skill",
      "List, add, or activate Code Mode session skills.",
      codeSkillSchema,
      (p) => {
        if (p.command === "add") {
          return `code skill add ${requiredSingleLineCodeParam(
            p.name as string | undefined,
            "name",
            "name is required",
          )} ${requiredSingleLineCodeParam(
            p.text as string | undefined,
            "text",
            "text is required",
          )}`;
        }
        if (p.command === "use") {
          return `code skill use ${requiredSingleLineCodeParam(
            p.name as string | undefined,
            "name",
            "name is required",
          )}`;
        }
        return "code skill list";
      },
      ctx,
    ),
    wrap(
      "marina_code_thread",
      "Code Thread",
      "Show the compact artifact thread for the active coding session.",
      codeEmptySchema,
      () => "code thread",
      ctx,
    ),
    wrap(
      "marina_code_crew",
      "Code Crew",
      "Store a coding crew orchestration plan for the active session.",
      codeTextSchema,
      (p) =>
        `code crew ${requiredSingleLineCodeParam(p.text as string | undefined, "text", "text is required")}`,
      ctx,
    ),
    wrap(
      "marina_code_external",
      "Code External Link",
      "Show, create, or archive an external coding-session link.",
      codeExternalSchema,
      (p) => {
        if (p.command === "link") {
          return `code external link ${requiredSingleLineCodeParam(
            p.system as string | undefined,
            "system",
            "system is required",
          )} ${requiredSingleLineCodeParam(
            p.externalId as string | undefined,
            "externalId",
            "externalId is required",
          )}`;
        }
        if (p.command === "unlink") {
          return `code external unlink ${requiredSingleLineCodeParam(
            p.artifactId as string | undefined,
            "artifactId",
            "artifactId is required",
          )}`;
        }
        return "code external";
      },
      ctx,
    ),
  ];
}

function buildCodeCommand(params: Record<string, unknown>): string {
  const action = params.action as string;
  const path = params.path as string | undefined;
  const query = params.query as string | undefined;
  const command = params.command as string | undefined;
  const title = params.title as string | undefined;
  const diff = params.diff as string | undefined;
  const artifactId = params.artifactId as string | undefined;
  const kind = params.kind as string | undefined;
  const status = params.status as string | undefined;
  const text = params.text as string | undefined;

  switch (action) {
    case "status":
      return "code status";
    case "files":
      return `code files ${singleLineCodeParam(path ?? ".", "path")}`;
    case "read":
      return `code read ${requiredSingleLineCodeParam(path, "path", "action=read requires path")}`;
    case "search":
      return `code search ${requiredSingleLineCodeParam(query, "query", "action=search requires query")}`;
    case "diff":
      return path ? `code diff ${singleLineCodeParam(path, "path")}` : "code diff";
    case "run":
      return `code run ${requiredSingleLineCodeParam(command, "command", "action=run requires command")}`;
    case "verify":
      return "code verify";
    case "observe":
      return `code observe ${requiredSingleLineCodeParam(text, "text", "action=observe requires text")}`;
    case "patch":
      return `code patch ${singleLineCodeParam(title ?? "Proposed change", "title")}\n${requiredCodeDiff(diff)}`;
    case "apply":
      return `code apply ${requiredSingleLineCodeParam(artifactId, "artifactId", "action=apply requires artifactId")}`;
    case "reject":
      return `code reject ${requiredSingleLineCodeParam(
        artifactId,
        "artifactId",
        "action=reject requires artifactId",
      )}${text ? ` ${singleLineCodeParam(text, "text")}` : ""}`;
    case "show":
      return `code show ${requiredSingleLineCodeParam(artifactId, "artifactId", "action=show requires artifactId")}`;
    case "patches":
      return status ? `code patches ${validatedPatchStatus(status)}` : "code patches";
    case "artifacts":
      return kind ? `code artifacts kind ${singleLineCodeParam(kind, "kind")}` : "code artifacts";
    case "history":
      return "code history";
    case "workspace":
      if (command === "list") return "code workspace list";
      if (command === "use" && path)
        return `code workspace use ${singleLineCodeParam(path, "path")}`;
      return "code workspace";
    case "doctor":
      return "code doctor";
    case "recipe":
      if (command === "run") {
        return `code recipe run ${requiredSingleLineCodeParam(kind, "name", "action=recipe run requires kind/name")}`;
      }
      if (command === "save") {
        return `code recipe save ${requiredSingleLineCodeParam(
          kind,
          "name",
          "action=recipe save requires kind/name",
        )} ${requiredSingleLineCodeParam(text, "text", "action=recipe save requires text")}`;
      }
      return "code recipe list";
    case "checkpoint":
      return text ? `code checkpoint ${singleLineCodeParam(text, "text")}` : "code checkpoint";
    case "revert":
      return `code revert ${requiredSingleLineCodeParam(artifactId, "artifactId", "action=revert requires artifactId")}`;
    case "approval":
      return `code approval request ${requiredSingleLineCodeParam(
        kind,
        "kind",
        "action=approval requires kind",
      )} ${requiredSingleLineCodeParam(text, "text", "action=approval requires text")}`;
    case "approve":
      return `code approve ${requiredSingleLineCodeParam(artifactId, "artifactId", "action=approve requires artifactId")}`;
    case "deny":
      return `code deny ${requiredSingleLineCodeParam(artifactId, "artifactId", "action=deny requires artifactId")}`;
    case "model":
      if (command === "set") {
        return `code model set ${requiredSingleLineCodeParam(text, "text", "action=model command=set requires text target")}`;
      }
      if (command === "clear") return "code model clear";
      return "code model";
    case "skill":
      if (command === "add") {
        return `code skill add ${requiredSingleLineCodeParam(
          kind,
          "name",
          "action=skill command=add requires kind/name",
        )} ${requiredSingleLineCodeParam(text, "text", "action=skill command=add requires text")}`;
      }
      if (command === "use") {
        return `code skill use ${requiredSingleLineCodeParam(kind, "name", "action=skill command=use requires kind/name")}`;
      }
      return "code skill list";
    case "thread":
      return "code thread";
    case "crew":
      return `code crew ${requiredSingleLineCodeParam(text, "text", "action=crew requires text")}`;
    case "roles":
      return "code roles";
    case "external":
      if (command === "link") {
        return `code external link ${requiredSingleLineCodeParam(
          kind,
          "system",
          "action=external command=link requires kind/system",
        )} ${requiredSingleLineCodeParam(text, "text", "action=external command=link requires text external id")}`;
      }
      if (command === "unlink") {
        return `code external unlink ${requiredSingleLineCodeParam(
          artifactId,
          "artifactId",
          "action=external command=unlink requires artifactId",
        )}`;
      }
      return "code external";
    case "plan":
    case "summary":
    case "handoff":
    case "decision":
      return `code ${action} ${requiredSingleLineCodeParam(
        text,
        "text",
        `action=${action} requires text`,
      )}`;
    default:
      return "code status";
  }
}

function requiredSingleLineCodeParam(
  value: string | undefined,
  name: string,
  message: string,
): string {
  if (!value?.trim()) throw new Error(message);
  return singleLineCodeParam(value, name);
}

function singleLineCodeParam(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.includes("\n") || normalized.includes("\r")) {
    throw new Error(`${name} must be a single line`);
  }
  return normalized;
}

function requiredCodeDiff(value: string | undefined): string {
  if (!value?.trim()) throw new Error("action=patch requires diff");
  return value.endsWith("\n") ? value : `${value}\n`;
}

function validatedPatchStatus(value: string): string {
  const status = singleLineCodeParam(value, "status").toLowerCase();
  if (status !== "pending" && status !== "applied" && status !== "rejected") {
    throw new Error("action=patches status must be pending, applied, or rejected");
  }
  return status;
}
