// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { dim, error as fmtError } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { getErrorMessage } from "../errors";
import { getRank } from "../permissions";
import { checkGateForExecution, recordGateExecution } from "../safety-gates";
import type { ShellRuntime } from "../shell-runtime";
import { isLocalUngated } from "../trust-profile";

const HELP = `Execute shell commands.
Gated capability: earn it via \`witness request agent.run\` or an operator grant (see \`standing\`).
Usage: run <binary> [args...]
       run quiet <binary> [args...]
       run raw <command string>

Examples:
  run curl -s https://api.example.com/data
  run ls
  run quiet wget -O data.json https://example.com/data.json
  run raw curl https://api.example.com | jq .data`;

export interface RunDeps {
  getEntity: (id: string) => Entity | undefined;
  shellRuntime: ShellRuntime;
  /** Gate ledger for `run raw`'s `shell.exec` check; absent ⇒ the sovereign rank floor. */
  db?: MarinaDB;
}

/**
 * The `shell.exec` gate for a raw `sh -c` string, checked imperatively and
 * recorded on a pass. It behaves as the gate does everywhere: passes under
 * the local-ungated profile, is part of the open-posture core (never passed
 * by `open`), and a refusal raises a challenge rather than a wall. Without a
 * database (no gate ledger) the sovereign rank stands in, as before — shell
 * execution is core, so `open` does not lift it; the local profile does.
 */
export function shellExecRefusal(
  db: MarinaDB | undefined,
  entity: Entity,
  evidence: string,
): string | undefined {
  if (!db) {
    return getRank(entity) >= 9 || isLocalUngated()
      ? undefined
      : "Raw shell mode requires sovereign rank (9).";
  }
  const gate = checkGateForExecution(db, entity.id, "shell.exec");
  if (!gate.ok) return gate.reason ?? 'Gate "shell.exec" denied.';
  recordGateExecution(db, entity.id, "shell.exec", gate, evidence.slice(0, 200));
  return undefined;
}

export function runCommand(deps: RunDeps): CommandDef {
  return {
    category: "Agents",
    usage: ["run <binary> [args...]", "run quiet <binary> [args...]", "run raw <command string>"],
    name: "run",
    aliases: [],
    help: HELP,
    minRank: 5,
    gate: "agent.run",
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;
      const eid = input.entity;
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub) {
        ctx.send(eid, HELP);
        return;
      }

      // run quiet <binary> [args...]
      if (sub === "quiet") {
        const binary = tokens[1];
        if (!binary) {
          ctx.send(eid, "Usage: run quiet <binary> [args...]");
          return;
        }
        try {
          const result = await deps.shellRuntime.exec(eid, binary, tokens.slice(2));
          // Quiet mode: only show status line, not output
          const status = result.timedOut
            ? `[timed out — exit ${result.exitCode}]`
            : `[exit ${result.exitCode}]`;
          const files =
            result.newFiles.length > 0 ? ` — new files: ${result.newFiles.join(", ")}` : "";
          ctx.send(eid, `${dim(status)}${files} output: ${result.outputFile}`);
        } catch (err) {
          ctx.send(eid, fmtError(getErrorMessage(err)));
        }
        return;
      }

      // run raw <command string> — a full `sh -c` string, so it takes the
      // `shell.exec` gate on top of the command's own `agent.run` gate.
      if (sub === "raw") {
        const commandString = tokens.slice(1).join(" ");
        if (!commandString) {
          ctx.send(eid, "Usage: run raw <command string>");
          return;
        }
        const refusal = shellExecRefusal(deps.db, entity, `run raw ${commandString}`);
        if (refusal) {
          ctx.send(eid, refusal);
          return;
        }
        try {
          const result = await deps.shellRuntime.execRaw(eid, commandString);
          formatOutput(ctx, eid, commandString, result);
        } catch (err) {
          ctx.send(eid, fmtError(getErrorMessage(err)));
        }
        return;
      }

      // run <binary> [args...]
      const binary = sub;
      const args = tokens.slice(1);
      try {
        const result = await deps.shellRuntime.exec(eid, binary, args);
        const cmdDisplay = `${binary}${args.length > 0 ? ` ${args.join(" ")}` : ""}`;
        formatOutput(ctx, eid, cmdDisplay, result);
      } catch (err) {
        ctx.send(eid, fmtError(getErrorMessage(err)));
      }
    },
  };
}

function formatOutput(
  ctx: RoomContext,
  eid: EntityId,
  cmdDisplay: string,
  result: {
    exitCode: number;
    preview: string;
    outputFile: string;
    truncated: boolean;
    timedOut: boolean;
    newFiles: string[];
  },
): void {
  const lines: string[] = [];
  lines.push(dim(`$ ${cmdDisplay}`));

  if (result.preview.trim()) {
    lines.push(result.preview);
  }

  if (result.truncated) {
    lines.push(dim(`[truncated — full output: ${result.outputFile}]`));
  }

  if (result.timedOut) {
    lines.push(fmtError("[timed out]"));
  }

  const exitStr = result.exitCode !== 0 ? fmtError(`[exit ${result.exitCode}]`) : dim("[exit 0]");
  const filesStr = result.newFiles.length > 0 ? ` — new files: ${result.newFiles.join(", ")}` : "";
  lines.push(`${exitStr} output: ${dim(result.outputFile)}${filesStr}`);

  ctx.send(eid, lines.join("\n"));
}
