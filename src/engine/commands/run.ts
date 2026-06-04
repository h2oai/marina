import { dim, error as fmtError } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { getErrorMessage } from "../errors";
import { getRank } from "../permissions";
import type { ShellRuntime } from "../shell-runtime";

const HELP = `Execute shell commands.
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
}

export function runCommand(deps: RunDeps): CommandDef {
  return {
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

      // run raw <command string> — sovereign only
      if (sub === "raw") {
        const rank = getRank(entity);
        if (rank < 9) {
          ctx.send(eid, "Raw shell mode requires sovereign rank (9).");
          return;
        }
        const commandString = tokens.slice(1).join(" ");
        if (!commandString) {
          ctx.send(eid, "Usage: run raw <command string>");
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
