import { ApplicationMenu, Utils } from "electrobun/bun";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  exportState,
  importState,
  validateSnapshot,
} from "../../../src/persistence/export-import";
import type { EngineHost } from "./engine-host";
import type { Preferences } from "./preferences";
import { savePreferences } from "./preferences";
import type { AppPaths } from "./paths";

interface AppContext {
  engineHost: EngineHost | null;
  mainWindow: {
    close(): void;
    focus(): void;
    setFullScreen?(fs: boolean): void;
    isFullScreen?(): boolean;
  } | null;
  prefs: Preferences;
  paths: AppPaths;
  startLocalEngine(): Promise<void>;
  stopLocalEngine(): Promise<void>;
  switchToLocal(): Promise<void>;
  switchToRemote(url: string): Promise<void>;
  reloadWindow(): void;
}

/**
 * Set up the native application menu with fully wired actions.
 */
export function initMenu(app: AppContext): void {
  ApplicationMenu.setApplicationMenu([
    {
      label: "File",
      submenu: [
        { label: "New World...", action: "file:new-world" },
        { label: "Open Database...", action: "file:open-db" },
        { type: "separator" },
        {
          label: "Connect to Server...",
          action: "file:connect-remote",
        },
        { type: "separator" },
        { label: "Export State...", action: "file:export" },
        { label: "Import State...", action: "file:import" },
        { type: "separator" },
        { label: "Quit", role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", role: "undo" },
        { label: "Redo", role: "redo" },
        { type: "separator" },
        { label: "Cut", role: "cut" },
        { label: "Copy", role: "copy" },
        { label: "Paste", role: "paste" },
        { type: "separator" },
        { label: "Select All", role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", action: "view:reload", accelerator: "r" },
        { type: "separator" },
        {
          label: "Toggle Full Screen",
          action: "view:fullscreen",
          accelerator: "f",
        },
      ],
    },
    {
      label: "Server",
      submenu: [
        { label: "Start Engine", action: "server:start" },
        { label: "Stop Engine", action: "server:stop" },
        { type: "separator" },
        { label: "Engine Status", action: "server:status" },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "Documentation", action: "help:docs" },
        { label: "Report Issue", action: "help:issue" },
        { type: "separator" },
        { label: "Open Data Directory", action: "help:open-data" },
      ],
    },
  ]);

  // Handle menu actions
  ApplicationMenu.on("application-menu-clicked", async (event: unknown) => {
    const action =
      typeof event === "string"
        ? event
        : (event as { data?: { action?: string } })?.data?.action ?? "";

    try {
      switch (action) {
        case "file:new-world":
          await handleNewWorld(app);
          break;
        case "file:open-db":
          await handleOpenDatabase(app);
          break;
        case "file:connect-remote":
          await handleConnectRemote(app);
          break;
        case "file:export":
          await handleExportState(app);
          break;
        case "file:import":
          await handleImportState(app);
          break;
        case "server:start":
          await handleStartEngine(app);
          break;
        case "server:stop":
          await handleStopEngine(app);
          break;
        case "server:status":
          await handleEngineStatus(app);
          break;
        case "view:reload":
          app.reloadWindow();
          break;
        case "view:fullscreen":
          handleToggleFullscreen(app);
          break;
        case "help:docs":
          Utils.openExternal(
            "https://github.com/h2oai/Marina#readme",
          );
          break;
        case "help:issue":
          Utils.openExternal(
            "https://github.com/h2oai/Marina/issues",
          );
          break;
        case "help:open-data":
          Utils.openPath(app.paths.dataDir);
          break;
      }
    } catch (err) {
      console.error(`[menu] Action ${action} failed:`, err);
      Utils.showNotification({
        title: "Marina",
        body: `Action failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

// ─── File Actions ────────────────────────────────────────────────────────────

async function handleNewWorld(app: AppContext): Promise<void> {
  const result = await Utils.showMessageBox({
    type: "question",
    title: "New World",
    message: "Create a new world?",
    detail:
      "This will stop the current engine, create a fresh database, and start a new world. Your current database will not be deleted.",
    buttons: ["Create New World", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });

  if (result.response !== 0) return;

  // Generate a timestamped database path
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const newDbPath = join(app.paths.dataDir, `marina-${timestamp}.db`);

  // Stop existing engine
  if (app.engineHost?.isRunning) {
    await app.stopLocalEngine();
  }

  // Update prefs to use new database
  app.prefs.mode = "local";
  app.prefs.dbPath = newDbPath;
  if (!app.prefs.recentDatabases.includes(newDbPath)) {
    app.prefs.recentDatabases.unshift(newDbPath);
    app.prefs.recentDatabases = app.prefs.recentDatabases.slice(0, 10);
  }
  savePreferences(app.paths.prefsFile, app.prefs);

  // Start engine with new database (it auto-creates + migrates)
  await app.startLocalEngine();
  app.reloadWindow();

  Utils.showNotification({
    title: "Marina",
    body: "New world created successfully.",
  });
}

async function handleOpenDatabase(app: AppContext): Promise<void> {
  const files = await Utils.openFileDialog({
    startingFolder: app.paths.dataDir,
    allowedFileTypes: "db,sqlite,sqlite3",
    canChooseFiles: true,
    canChooseDirectory: false,
    allowsMultipleSelection: false,
  });

  if (!files || files.length === 0) return;
  const dbPath = files[0]!;

  // Stop existing engine
  if (app.engineHost?.isRunning) {
    await app.stopLocalEngine();
  }

  // Update prefs
  app.prefs.mode = "local";
  app.prefs.dbPath = dbPath;
  if (!app.prefs.recentDatabases.includes(dbPath)) {
    app.prefs.recentDatabases.unshift(dbPath);
    app.prefs.recentDatabases = app.prefs.recentDatabases.slice(0, 10);
  }
  savePreferences(app.paths.prefsFile, app.prefs);

  // Start with selected database
  await app.startLocalEngine();
  app.reloadWindow();

  Utils.showNotification({
    title: "Marina",
    body: `Opened database: ${dbPath.split("/").pop()}`,
  });
}

async function handleConnectRemote(app: AppContext): Promise<void> {
  // Use message box to get URL since Electrobun doesn't have a text input dialog
  // Show recent servers if available
  const recentList =
    app.prefs.recentServers.length > 0
      ? app.prefs.recentServers.slice(0, 3)
      : [];

  const defaultUrl = process.env.MARINA_DEFAULT_REMOTE_URL ?? "http://localhost:3300";
  const buttons =
    recentList.length > 0 ? [...recentList, "Cancel"] : [defaultUrl, "Cancel"];

  const result = await Utils.showMessageBox({
    type: "question",
    title: "Connect to Server",
    message: "Select a server to connect to:",
    detail: recentList.length > 0
      ? "Choose a recent server or cancel to enter a custom URL in the dashboard settings."
      : "Connect to the default local server, or cancel to configure in settings.",
    buttons,
    cancelId: buttons.length - 1,
  });

  if (result.response === buttons.length - 1) return;

  const url = buttons[result.response]!;

  try {
    // Test the server first
    const healthUrl = `${url.replace(/\/$/, "")}/health`;
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      await Utils.showMessageBox({
        type: "error",
        title: "Connection Failed",
        message: `Server returned ${res.status}`,
        detail: `Could not connect to ${url}`,
      });
      return;
    }

    await app.switchToRemote(url);

    Utils.showNotification({
      title: "Marina",
      body: `Connected to ${url}`,
    });
  } catch (err) {
    await Utils.showMessageBox({
      type: "error",
      title: "Connection Failed",
      message: "Could not connect to server",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleExportState(app: AppContext): Promise<void> {
  if (!app.engineHost?.isRunning) {
    await Utils.showMessageBox({
      type: "warning",
      title: "Export State",
      message: "Engine is not running",
      detail: "Start the engine before exporting state.",
    });
    return;
  }

  const dbPath = app.prefs.dbPath || app.paths.defaultDb;

  try {
    const snapshot = exportState(dbPath, { skipEventLog: false });
    const json = JSON.stringify(snapshot, null, 2);

    // Save to data directory with timestamp
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const exportPath = join(
      app.paths.dataDir,
      `marina-export-${timestamp}.json`,
    );

    const dir = dirname(exportPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(exportPath, json);

    const result = await Utils.showMessageBox({
      type: "info",
      title: "Export Complete",
      message: `State exported successfully`,
      detail: `${snapshot.tables ? Object.keys(snapshot.tables).length : 0} tables exported to:\n${exportPath}`,
      buttons: ["Show in Finder", "OK"],
      defaultId: 1,
    });

    if (result.response === 0) {
      Utils.showItemInFolder(exportPath);
    }
  } catch (err) {
    await Utils.showMessageBox({
      type: "error",
      title: "Export Failed",
      message: "Could not export state",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleImportState(app: AppContext): Promise<void> {
  const files = await Utils.openFileDialog({
    startingFolder: app.paths.dataDir,
    allowedFileTypes: "json",
    canChooseFiles: true,
    canChooseDirectory: false,
    allowsMultipleSelection: false,
  });

  if (!files || files.length === 0) return;
  const importPath = files[0]!;

  // Read and validate the snapshot
  let snapshotJson: string;
  try {
    snapshotJson = await Bun.file(importPath).text();
  } catch (err) {
    await Utils.showMessageBox({
      type: "error",
      title: "Import Failed",
      message: "Could not read file",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson);
  } catch {
    await Utils.showMessageBox({
      type: "error",
      title: "Import Failed",
      message: "Invalid JSON file",
      detail: "The selected file is not valid JSON.",
    });
    return;
  }

  const validation = validateSnapshot(parsed);
  if (!validation.valid) {
    await Utils.showMessageBox({
      type: "error",
      title: "Import Failed",
      message: "Invalid snapshot format",
      detail: validation.error,
    });
    return;
  }

  // Confirm with user
  const tableCount = Object.keys(validation.snapshot.tables).length;
  const confirm = await Utils.showMessageBox({
    type: "warning",
    title: "Import State",
    message: "Import will replace all current data",
    detail: `This will import ${tableCount} tables from the snapshot, replacing all existing data. This cannot be undone.\n\nFile: ${importPath.split("/").pop()}`,
    buttons: ["Import (Replace)", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });

  if (confirm.response !== 0) return;

  const dbPath = app.prefs.dbPath || app.paths.defaultDb;

  // Stop engine during import
  const wasRunning = app.engineHost?.isRunning ?? false;
  if (wasRunning) {
    await app.stopLocalEngine();
  }

  try {
    const result = importState(dbPath, validation.snapshot, { merge: false });

    if (result.errors.length > 0) {
      await Utils.showMessageBox({
        type: "warning",
        title: "Import Completed with Warnings",
        message: `Imported ${result.rowsImported} rows across ${result.tablesImported} tables`,
        detail: `Warnings:\n${result.errors.join("\n")}`,
      });
    } else {
      Utils.showNotification({
        title: "Marina",
        body: `Imported ${result.rowsImported} rows across ${result.tablesImported} tables.`,
      });
    }
  } catch (err) {
    await Utils.showMessageBox({
      type: "error",
      title: "Import Failed",
      message: "Could not import state",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Restart engine
  if (wasRunning) {
    await app.startLocalEngine();
  }
  app.reloadWindow();
}

// ─── Server Actions ──────────────────────────────────────────────────────────

async function handleStartEngine(app: AppContext): Promise<void> {
  if (app.engineHost?.isRunning) {
    Utils.showNotification({
      title: "Marina",
      body: "Engine is already running.",
    });
    return;
  }

  await app.startLocalEngine();
  app.reloadWindow();

  Utils.showNotification({
    title: "Marina",
    body: "Engine started.",
  });
}

async function handleStopEngine(app: AppContext): Promise<void> {
  if (!app.engineHost?.isRunning) {
    Utils.showNotification({
      title: "Marina",
      body: "Engine is not running.",
    });
    return;
  }

  const confirm = await Utils.showMessageBox({
    type: "question",
    title: "Stop Engine",
    message: "Stop the Marina engine?",
    detail:
      "All connected agents will be disconnected. World state will be saved.",
    buttons: ["Stop Engine", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });

  if (confirm.response !== 0) return;

  await app.stopLocalEngine();
  app.reloadWindow();

  Utils.showNotification({
    title: "Marina",
    body: "Engine stopped. World state saved.",
  });
}

async function handleEngineStatus(app: AppContext): Promise<void> {
  if (!app.engineHost?.isRunning) {
    await Utils.showMessageBox({
      type: "info",
      title: "Engine Status",
      message: "Engine is not running",
      detail: "Use Server > Start Engine to start.",
    });
    return;
  }

  const status = app.engineHost.getStatus();
  const uptime = Math.floor(status.uptime / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = uptime % 60;
  const uptimeStr =
    hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;

  const heapMB = (status.memory.heapUsed / 1024 / 1024).toFixed(1);
  const rssMB = (status.memory.rss / 1024 / 1024).toFixed(1);
  const dbPath = app.prefs.dbPath || app.paths.defaultDb;

  await Utils.showMessageBox({
    type: "info",
    title: "Engine Status",
    message: "Marina Engine Running",
    detail: [
      `Uptime: ${uptimeStr}`,
      `Rooms: ${status.roomCount}`,
      `Entities: ${status.entityCount} (${status.agentCount} agents)`,
      `Connections: ${status.connectionCount}`,
      `Memory: ${heapMB} MB heap, ${rssMB} MB RSS`,
      `Database: ${dbPath.split("/").pop()}`,
      `Ports: WS ${app.prefs.wsPort}, Telnet ${app.prefs.telnetPort}, MCP ${app.prefs.mcpPort}`,
    ].join("\n"),
  });
}

// ─── View Actions ────────────────────────────────────────────────────────────

function handleToggleFullscreen(app: AppContext): void {
  const win = app.mainWindow as any;
  if (!win) return;
  if (typeof win.setFullScreen === "function") {
    const isFull =
      typeof win.isFullScreen === "function" ? win.isFullScreen() : false;
    win.setFullScreen(!isFull);
  }
}
