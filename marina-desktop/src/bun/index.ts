// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { BrowserWindow, defineElectrobunRPC } from "electrobun/bun";
import { EngineHost } from "./engine-host";
import { initMenu } from "./menu";
import { getAppPaths } from "./paths";
import { loadPreferences, savePreferences } from "./preferences";
import { createRpcHandlers } from "./rpc-handlers";
import type { DashboardRPCSchema, PreferencesData } from "./rpc-schema";
import { initTray } from "./tray";
import { resolveWorld } from "./worlds";
import type { EngineEvent, Perception } from "../../../src/types";

// ─── Configuration ──────────────────────────────────────────────────────────

const paths = getAppPaths();
const prefs = loadPreferences(paths.prefsFile);

// ─── Engine ─────────────────────────────────────────────────────────────────

let engineHost: EngineHost | null = null;
let mainWindow: InstanceType<typeof BrowserWindow> | null = null;
let rpc: ReturnType<typeof defineElectrobunRPC<DashboardRPCSchema, "bun">>;
let stateInterval: ReturnType<typeof setInterval> | null = null;
let eventListener: ((event: import("../../../src/types").EngineEvent) => void) | null = null;

async function startLocalEngine(): Promise<void> {
  const world = resolveWorld(prefs.world);
  engineHost = new EngineHost({
    dbPath: prefs.dbPath || paths.defaultDb,
    wsPort: prefs.wsPort,
    telnetPort: prefs.telnetPort,
    mcpPort: prefs.mcpPort,
    tickMs: prefs.tickMs,
    startRoom: prefs.startRoom || (world.startRoom as string),
    roomsDir: paths.roomsDir,
    world,
  });
  await engineHost.start();

  // Wire RPC push messages: forward snapshots and events to the webview
  wireRpcPush();
}

async function stopLocalEngine(): Promise<void> {
  unwireRpcPush();
  if (engineHost) {
    await engineHost.shutdown();
    engineHost = null;
  }
}

/** Forward engine state snapshots and events to the webview via RPC push */
function wireRpcPush(): void {
  if (!engineHost || !rpc) return;

  const engine = engineHost.getEngine();
  if (!engine) return;

  // Periodic state snapshots (every 2s, matching DashboardBroadcaster)
  stateInterval = setInterval(() => {
    if (!engineHost?.isRunning) return;
    const eng = engineHost.getEngine();
    if (!eng) return;

    const entities = eng.entities.all().map((e) => ({
      id: e.id as string,
      name: e.name,
      kind: e.kind,
      room: e.room as string,
    }));

    const roomPopulations: Record<string, number> = {};
    for (const e of entities) {
      roomPopulations[e.room] = (roomPopulations[e.room] ?? 0) + 1;
    }

    const rooms = eng.rooms.all().map((r) => ({
      id: r.id as string,
      short: r.module.short,
      district: (r.id as string).split("/")[0] ?? "",
      exits: Object.fromEntries(
        Object.entries(r.module.exits ?? {}).map(([k, v]) => [
          k,
          v as string,
        ]),
      ),
    }));

    const mem = process.memoryUsage();

    try {
      rpc.send.state({
        timestamp: Date.now(),
        entities,
        roomPopulations,
        rooms,
        connections: eng.getConnections().size,
        memory: { heapUsed: mem.heapUsed, rss: mem.rss },
      });
    } catch {
      // Webview may not be ready yet
    }
  }, 2000);

  // Forward individual engine events
  eventListener = (event) => {
    if (event.type === "tick") return;
    try {
      rpc.send.event(event);
    } catch {
      // Webview may not be ready yet
    }
  };
  engine.addEventListener(eventListener);
}

function unwireRpcPush(): void {
  if (stateInterval) {
    clearInterval(stateInterval);
    stateInterval = null;
  }
  // Remove the event listener to prevent accumulation across restarts
  if (eventListener && engineHost) {
    const engine = engineHost.getEngine();
    if (engine) {
      engine.removeEventListener(eventListener);
    }
  }
  eventListener = null;
}

// ─── RPC ────────────────────────────────────────────────────────────────────

function getPreferencesData(): PreferencesData {
  return {
    mode: prefs.mode,
    remoteUrl: prefs.remoteUrl,
    dbPath: prefs.dbPath || paths.defaultDb,
    wsPort: prefs.wsPort,
    telnetPort: prefs.telnetPort,
    mcpPort: prefs.mcpPort,
    tickMs: prefs.tickMs,
    startRoom: prefs.startRoom,
  };
}

function setPreferencesData(partial: Partial<PreferencesData>): void {
  Object.assign(prefs, partial);
  savePreferences(paths.prefsFile, prefs);
}

const rpcHandlers = createRpcHandlers(
  () => engineHost,
  {
    getPreferences: getPreferencesData,
    setPreferences: setPreferencesData,
    switchToRemote,
    switchToLocal,
  },
  (perception: unknown) => {
    try {
      rpc.send.gameMessage(perception as Perception);
    } catch {
      // Webview may not be ready
    }
  },
  (event: unknown) => {
    try {
      rpc.send.canvasEvent(event as EngineEvent);
    } catch {
      // Webview may not be ready
    }
  },
);

rpc = defineElectrobunRPC<DashboardRPCSchema, "bun">("bun", {
  handlers: {
    requests: rpcHandlers,
    messages: {
      ready: () => {
        // Send initial snapshot if engine is running
        if (engineHost?.isRunning) {
          const eng = engineHost.getEngine();
          if (eng) {
            const entities = eng.entities.all().map((e) => ({
              id: e.id as string,
              name: e.name,
              kind: e.kind,
              room: e.room as string,
            }));
            const roomPopulations: Record<string, number> = {};
            for (const e of entities) {
              roomPopulations[e.room] =
                (roomPopulations[e.room] ?? 0) + 1;
            }
            const rooms = eng.rooms.all().map((r) => ({
              id: r.id as string,
              short: r.module.short,
              district: (r.id as string).split("/")[0] ?? "",
              exits: Object.fromEntries(
                Object.entries(r.module.exits ?? {}).map(([k, v]) => [
                  k,
                  v as string,
                ]),
              ),
            }));
            const mem = process.memoryUsage();
            rpc.send.snapshot({
              timestamp: Date.now(),
              entities,
              roomPopulations,
              rooms,
              connections: eng.getConnections().size,
              memory: { heapUsed: mem.heapUsed, rss: mem.rss },
            });
          }
        }
      },
    },
  },
});

// ─── Window ─────────────────────────────────────────────────────────────────

function getDashboardUrl(): string {
  if (prefs.mode === "remote" && prefs.remoteUrl) {
    const base = prefs.remoteUrl.replace(/\/$/, "");
    return `${base}/dashboard`;
  }
  // Local mode: load from bundled views via Electrobun's views:// protocol
  return "views://dashboard/index.html";
}

async function createMainWindow(): Promise<void> {
  const bounds = prefs.windowBounds ?? { width: 1280, height: 800 };
  mainWindow = new BrowserWindow({
    title: "Marina",
    url: getDashboardUrl(),
    rpc,
    frame: {
      x: bounds.x ?? 100,
      y: bounds.y ?? 100,
      width: bounds.width,
      height: bounds.height,
    },
  });
}

function reloadWindow(): void {
  if (mainWindow) {
    mainWindow.close();
    createMainWindow();
  }
}

// ─── Mode Switching ─────────────────────────────────────────────────────────

async function switchToLocal(): Promise<void> {
  await stopLocalEngine();
  prefs.mode = "local";
  savePreferences(paths.prefsFile, prefs);
  await startLocalEngine();
  reloadWindow();
}

async function switchToRemote(url: string): Promise<void> {
  await stopLocalEngine();
  prefs.mode = "remote";
  prefs.remoteUrl = url;
  if (!prefs.recentServers.includes(url)) {
    prefs.recentServers.unshift(url);
    prefs.recentServers = prefs.recentServers.slice(0, 10);
  }
  savePreferences(paths.prefsFile, prefs);
  reloadWindow();
}

// ─── App Lifecycle ──────────────────────────────────────────────────────────

// Export for menu/tray to use
export const app = {
  get engineHost() {
    return engineHost;
  },
  get mainWindow() {
    return mainWindow;
  },
  prefs,
  paths,
  startLocalEngine,
  stopLocalEngine,
  switchToLocal,
  switchToRemote,
  reloadWindow,
  getDashboardUrl,
};

// Boot sequence
async function main(): Promise<void> {
  // Start engine in local mode
  if (prefs.mode === "local") {
    await startLocalEngine();
  }

  // Open the main window (uses views://dashboard/index.html with RPC)
  await createMainWindow();

  // Set up native chrome
  initMenu(app);
  initTray(app);
}

main().catch((err) => {
  console.error("[desktop] Fatal startup error:", err);
  process.exit(1);
});
