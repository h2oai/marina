import {
  type FlywheelExecutionResult,
  FlywheelExecutionTimeoutError,
  type FlywheelToolBackend,
} from "../integrations/flywheel-manager";
import type { EntityId } from "../types";
import type { WorkspaceRunResult, WorkspaceRuntime } from "./local-workspace";

const MAX_FLYWHEEL_OUTPUT_BYTES = 64 * 1024;
const EXIT_SENTINEL = "__MARINA_EXIT_7f31c9__=";
const EXIT_WRAPPER = `"$@"; marina_status=$?; printf '\n${EXIT_SENTINEL}%s\n' "$marina_status"; exit "$marina_status"`;

export type WorkspaceExecutionTarget = "local" | "flywheel";

export interface WorkspaceExecutionEvidence {
  result: WorkspaceRunResult;
  target: WorkspaceExecutionTarget;
  flywheelEvents?: FlywheelExecutionResult["events"];
}

/**
 * Policy seam between Code Mode and execution providers. Selection is always
 * explicit; a selected Flywheel target never falls back to LocalWorkspace.
 */
export class WorkspaceGateway {
  constructor(
    private readonly local: WorkspaceRuntime,
    private readonly flywheel?: FlywheelToolBackend,
  ) {}

  async run(
    entityId: EntityId,
    target: WorkspaceExecutionTarget,
    command: string[],
    timeoutMs = 120_000,
  ): Promise<WorkspaceExecutionEvidence> {
    if (target === "local") {
      return { result: await this.local.run(command, timeoutMs), target };
    }
    if (!this.flywheel?.execDetailed) {
      throw new Error(
        "Flywheel execution is unavailable; the command was not run locally. Use `code sandbox local` to change the session target explicitly.",
      );
    }
    const workspace = this.flywheel.status(entityId);
    if (!workspace) {
      throw new Error(
        "This entity has no Flywheel sandbox; use `code sandbox start` first. The command was not run locally.",
      );
    }
    if (workspace.state !== "running") {
      throw new Error(`Flywheel sandbox is ${workspace.state}; the command was not run locally.`);
    }
    if (command.length === 0) throw new Error("Cannot execute an empty command.");

    const startedAt = performance.now();
    let executed: FlywheelExecutionResult;
    try {
      executed = await this.flywheel.execDetailed(
        entityId,
        "/bin/sh",
        ["-c", EXIT_WRAPPER, "marina-code", ...command],
        undefined,
        { timeoutMs },
      );
    } catch (error) {
      if (error instanceof FlywheelExecutionTimeoutError) {
        return {
          target,
          result: {
            command,
            exitCode: 124,
            output: error.message,
            truncated: false,
            timedOut: true,
            durationMs: Math.round(performance.now() - startedAt),
          },
        };
      }
      throw error;
    }
    const parsed = parseExitSentinel(executed.output);
    const bounded = boundOutput(parsed.output, MAX_FLYWHEEL_OUTPUT_BYTES);
    return {
      target,
      flywheelEvents: executed.events,
      result: {
        command,
        exitCode: parsed.exitCode,
        output: bounded.output,
        truncated: bounded.truncated,
        timedOut: false,
        durationMs: Math.round(performance.now() - startedAt),
      },
    };
  }
}

function parseExitSentinel(output: string): { output: string; exitCode: number } {
  const pattern = new RegExp(`(?:^|\\n)${EXIT_SENTINEL}(\\d+)(?:\\n|$)`, "g");
  let match: RegExpExecArray | null = null;
  let candidate: RegExpExecArray | null;
  while ((candidate = pattern.exec(output)) !== null) match = candidate;
  if (!match) {
    throw new Error(
      "Flywheel execution ended without a terminal status; outcome is unknown and was not retried locally.",
    );
  }
  return {
    exitCode: Number(match[1]),
    output:
      `${output.slice(0, match.index)}${output.slice(match.index + match[0].length)}`.trimEnd(),
  };
}

function boundOutput(output: string, maxBytes: number): { output: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(output);
  if (bytes.length <= maxBytes) return { output, truncated: false };
  return {
    output: `${new TextDecoder().decode(bytes.slice(0, maxBytes))}\n[output truncated]`,
    truncated: true,
  };
}

export function summarizeFlywheelEvents(events: FlywheelExecutionResult["events"]): string[] {
  return events.map((event) => {
    const body = event.body as { case?: unknown } | undefined;
    if (typeof body?.case === "string") return body.case;
    for (const kind of ["process", "error", "completed", "childSpawned", "storage"]) {
      if (event[kind] !== undefined) return kind;
    }
    return "unknown";
  });
}
