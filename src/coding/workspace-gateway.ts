// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { assertCredentialFreeCommand, redactSensitiveText } from "../security/secret-redaction";
import type { EntityId } from "../types";
import type { WorkspaceRunResult, WorkspaceRuntime } from "./local-workspace";
import {
  LOCAL_TARGET,
  type SandboxExecutionResult,
  SandboxExecutionTimeoutError,
  type SandboxProvider,
  SandboxProviders,
  type SandboxTarget,
} from "./sandbox-provider";

const MAX_SANDBOX_OUTPUT_BYTES = 64 * 1024;
const EXIT_SENTINEL = "__MARINA_EXIT_7f31c9__=";
const EXIT_WRAPPER = `"$@"; marina_status=$?; printf '\n${EXIT_SENTINEL}%s\n' "$marina_status"; exit "$marina_status"`;

/** `local` or a registered sandbox provider id. */
export type WorkspaceExecutionTarget = SandboxTarget;

export interface WorkspaceExecutionEvidence {
  result: WorkspaceRunResult;
  target: WorkspaceExecutionTarget;
  /** The provider's structured events (kept as evidence). */
  flywheelEvents?: SandboxExecutionResult["events"];
}

/**
 * Policy seam between Code Mode and execution providers. Selection is always
 * explicit; a selected provider never falls back to LocalWorkspace.
 */
export class WorkspaceGateway {
  private readonly providers: SandboxProviders;

  constructor(
    private readonly local: WorkspaceRuntime | undefined,
    providers?: SandboxProviders | SandboxProvider,
  ) {
    this.providers =
      providers instanceof SandboxProviders
        ? providers
        : new SandboxProviders(providers ? [providers] : []);
  }

  async run(
    entityId: EntityId,
    target: WorkspaceExecutionTarget,
    command: string[],
    timeoutMs = 120_000,
    cwd?: string,
  ): Promise<WorkspaceExecutionEvidence> {
    if (target === LOCAL_TARGET) {
      if (!this.local) throw new Error("Local workspace execution is unavailable.");
      return { result: await this.local.run(command, timeoutMs), target };
    }
    const provider = this.providers.get(target);
    if (!provider?.execDetailed) {
      throw new Error(
        `${provider?.label ?? `Sandbox provider "${target}"`} execution is unavailable; the command was not run locally. Use \`code sandbox local\` to change the session target explicitly.`,
      );
    }
    const workspace = provider.status(entityId);
    if (!workspace) {
      throw new Error(
        `This entity has no ${provider.label} sandbox; use \`code sandbox start\` first. The command was not run locally.`,
      );
    }
    if (workspace.state !== "running") {
      throw new Error(
        `${provider.label} sandbox is ${workspace.state}; the command was not run locally.`,
      );
    }
    if (command.length === 0) throw new Error("Cannot execute an empty command.");
    assertCredentialFreeCommand(command);

    const startedAt = performance.now();
    let executed: SandboxExecutionResult;
    try {
      executed = await provider.execDetailed(
        entityId,
        "/bin/sh",
        ["-c", EXIT_WRAPPER, "marina-code", ...command],
        cwd,
        { timeoutMs },
      );
    } catch (error) {
      if (error instanceof SandboxExecutionTimeoutError) {
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
    const parsed = parseExitSentinel(executed.output, provider.label);
    const bounded = boundOutput(redactSensitiveText(parsed.output), MAX_SANDBOX_OUTPUT_BYTES);
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

function parseExitSentinel(output: string, label: string): { output: string; exitCode: number } {
  const pattern = new RegExp(`(?:^|\\n)${EXIT_SENTINEL}(\\d+)(?:\\n|$)`, "g");
  let match: RegExpExecArray | null = null;
  let candidate: RegExpExecArray | null;
  while ((candidate = pattern.exec(output)) !== null) match = candidate;
  if (!match) {
    throw new Error(
      `${label} execution ended without a terminal status; outcome is unknown and was not retried locally.`,
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

export function summarizeFlywheelEvents(events: SandboxExecutionResult["events"]): string[] {
  return events.map((event) => {
    const body = event.body as { case?: unknown } | undefined;
    if (typeof body?.case === "string") return body.case;
    for (const kind of ["process", "error", "completed", "childSpawned", "storage"]) {
      if (event[kind] !== undefined) return kind;
    }
    return "unknown";
  });
}
