// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `marina connect <name> --tui [--mode <name>]`: the terminal workspace with no coding
 * session. It shows the World conversation beside a use-case board (operate,
 * coordinate, memory, investigate, forecast, admin) on a session `marina connect`
 * already authenticated. It owns only its terminal: closing it leaves the world,
 * its agents and its tasks running.
 */

import { marinaPath } from "../src/config/marina-home";
import type { MarinaAgent, Perception } from "../src/sdk/client";
import { CodeConsole } from "./code-console";
import { HarnessStore } from "./code-harness";
import type { WorkspaceMode } from "./code-modes";

export interface WorldWorkspaceOptions {
  agent: MarinaAgent;
  /** The server's WebSocket URL (`ws://host:port`). */
  url: string;
  mode?: WorkspaceMode;
  /** Stops the caller's own printer and returns what it held back since login. */
  handoff: () => Perception[];
}

export async function runWorldWorkspace(options: WorldWorkspaceOptions): Promise<number> {
  const completed = Promise.withResolvers<number>();
  // Nothing is saved for a world view; the directory only satisfies the console's shape.
  const directory = marinaPath("world-view");
  const view = new CodeConsole({
    tui: true,
    worldOnly: true,
    connected: true,
    ...(options.mode ? { mode: options.mode } : {}),
    agent: options.agent,
    url: options.url.replace(/^ws/, "http"),
    root: "",
    directory,
    harness: { version: 1, agent: "marina" },
    store: new HarnessStore(directory),
    finish: (code) => completed.resolve(code),
  });
  const receive = (p: Perception) => {
    if (p.data?.capabilities) return;
    view.receive(p);
  };
  const disconnected = () => {
    view.write("Disconnected from the world. Nothing was replayed; reconnect with marina connect.");
    void view.close(1);
  };
  const terminate = () => void view.close(0);
  const early = options.handoff();
  options.agent.onPerception(receive);
  options.agent.on("disconnect", disconnected);
  process.on("SIGTERM", terminate);
  try {
    await view.start(true);
    for (const p of early) receive(p);
    return await completed.promise;
  } finally {
    process.off("SIGTERM", terminate);
    options.agent.off("disconnect", disconnected);
    options.agent.offPerception(receive);
    await view.close(0);
  }
}
