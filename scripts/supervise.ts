#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getErrorMessage } from "../src/engine/errors";
import { BUILTIN_AGENT_ADAPTERS } from "../src/routing/agent-adapters";
import { marinaResidentConnector, residentWorldUrl } from "../src/routing/resident-connection";
import { supervisedResidentsEnabled } from "../src/routing/residents";
import { openSupervision, type SupervisionHold } from "../src/routing/supervision-credential";
import { MarinaSupervisor } from "../src/routing/supervisor";
import {
  participantInstructions,
  residentInstructions,
} from "../src/routing/supervisor-instructions";
import { MarinaRoutingClient } from "../src/sdk/routing-client";
import { httpBaseFromUrl } from "./marina";
import { routingCachedToken } from "./route";

export { participantInstructions, residentInstructions };

/**
 * Supervisor options for supervised residents: on when this process has
 * MARINA_SUPERVISED_RESIDENTS on and the server offers residents (its
 * supervision endpoint answered). Otherwise nothing, so runs keep acting
 * through the supervisor's own account.
 */
export function residentSupervisorOptions(
  httpBase: string,
  residents: boolean = supervisedResidentsEnabled(),
) {
  return residents
    ? {
        residents: { connect: marinaResidentConnector(residentWorldUrl(httpBase)) },
        instructions: residentInstructions(),
      }
    : { instructions: participantInstructions() };
}

export const SUPERVISE_USAGE = `marina supervise --root <project> [--name <world-account>] [--state <directory>] [--label <name>]

Start an explicit local supervisor. In Dashboard → Workspace → Streams, select
the supervisor and launch installed Claude Code, Codex or pi agents. Native
output, tool events, permission requests and delivery receipts appear there.

Uses MARINA_URL and MARINA_TOKEN, or the named marina connect account cache.
The server can also run this supervisor itself: \`supervisor start\` in the world.
Each writer gets an isolated Git worktree by default. Shared directories are
an explicit launch choice. Agents retain native tools, settings and permission
systems; pi permissions depend on its installed extensions. This is local host
execution, not a container sandbox. Ctrl+C stops processes owned by this runner.
`;
export function parseSupervisorArgs(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    if (
      !["--root", "--name", "--state", "--label"].includes(key) ||
      !args[i + 1] ||
      values.has(key)
    )
      throw new Error(SUPERVISE_USAGE);
    values.set(key, args[i + 1]!);
  }
  if (!values.has("--root")) throw new Error(`An explicit --root is required\n${SUPERVISE_USAGE}`);
  return {
    root: values.get("--root")!,
    name: values.get("--name"),
    state: values.get("--state"),
    label: values.get("--label") ?? "Local agents",
  };
}
export async function runSupervisor(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(SUPERVISE_USAGE);
    return 0;
  }
  let supervisor: MarinaSupervisor | undefined;
  let supervision: SupervisionHold | undefined;
  let stopping = false;
  const shutdown = () => {
    stopping = true;
  };
  try {
    const options = parseSupervisorArgs(args);
    const root = realpathSync(options.root);
    const url = httpBaseFromUrl(process.env.MARINA_URL ?? "ws://localhost:3300");
    const token =
      process.env.MARINA_TOKEN ??
      (options.name ? routingCachedToken(options.name, url) : undefined);
    if (!token)
      throw new Error(
        "Set MARINA_TOKEN or use --name with an authenticated marina connect account",
      );
    const stateDirectory = resolve(
      options.state ??
        join(
          homedir(),
          ".marina",
          "runners",
          Bun.hash(`${url}:${options.name ?? "token"}:${root}`).toString(16),
        ),
    );
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const adapters = BUILTIN_AGENT_ADAPTERS.flatMap((adapter) => {
      const path = Bun.which(adapter.executable);
      return path ? [{ ...adapter, executable: path }] : [];
    });
    if (!adapters.length) throw new Error("No supported agent executables found in PATH");
    // Residents on: the supervisor's own routing credential, so the person's
    // next login (which replaces their world session) does not cut it off.
    if (supervisedResidentsEnabled()) {
      supervision = await openSupervision({ url, sessionToken: token });
      if (!supervision.held)
        console.error(
          "This Marina server does not offer supervised residents; agents act through your account.",
        );
    }
    supervisor = new MarinaSupervisor({
      client: supervision?.client ?? new MarinaRoutingClient({ url, token }),
      root,
      stateDirectory,
      label: options.label,
      binding: `${url}:${options.name ?? Bun.hash(token).toString(16)}:${root}`,
      adapters,
      agentEnvironment: { ...process.env, MARINA_URL: url, MARINA_TOKEN: token },
      secrets: [token],
      ...residentSupervisorOptions(url, supervision?.held === true),
    });
    const session = await supervisor.start();
    console.log(
      `Supervisor ${session.id}\nRoot: ${root}\nAdapters: ${adapters.map((a) => a.label).join(", ")}\nState: ${stateDirectory}\nOpen Marina → Workspace → Streams. Ctrl+C stops owned agents.`,
    );
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    while (!stopping) {
      try {
        await supervisor.tick();
      } catch (error) {
        console.error(
          `Routing disconnected: ${getErrorMessage(error)}. Output remains in the local journal.`,
        );
      }
      if (supervisor.failure) {
        console.error(supervisor.failure);
        break;
      }
      await Bun.sleep(2000);
    }
    await supervisor.stop();
    try {
      await supervisor.tick();
    } catch (error) {
      console.error(`Final output retained locally: ${getErrorMessage(error)}`);
    }
    return 0;
  } catch (error) {
    console.error(getErrorMessage(error));
    return 1;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    supervisor?.close();
    await supervision?.close();
  }
}
if (import.meta.main) process.exit(await runSupervisor(process.argv.slice(2)));
