import { Tray } from "electrobun/bun";

interface AppContext {
  engineHost: {
    isRunning: boolean;
    getStatus(): {
      running: boolean;
      agentCount: number;
      entityCount: number;
      connectionCount: number;
    };
  } | null;
  mainWindow: { focus?(): void } | null;
}

let tray: InstanceType<typeof Tray> | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize the system tray with status and quick actions.
 *
 * Tray API: constructor({ title, image, template, width, height })
 * Methods: setTitle(), setImage(), setMenu(), on("tray-clicked"), remove()
 */
export function initTray(app: AppContext): void {
  tray = new Tray({
    title: "Marina",
    image: "resources/tray-icon.png",
    template: true,
    width: 16,
    height: 16,
  });

  // Set initial menu
  updateTrayMenu(app);

  // Handle tray click — show/focus the main window
  tray.on("tray-clicked", () => {
    app.mainWindow?.focus?.();
  });

  // Update tray status every 5 seconds
  updateInterval = setInterval(() => {
    updateTray(app);
  }, 5000);
}

function buildTrayMenu(
  app: AppContext,
): Array<{
  label?: string;
  action?: string;
  type?: string;
  enabled?: boolean;
}> {
  const status = app.engineHost?.getStatus();

  const statusLine = status?.running
    ? `Agents: ${status.agentCount} | Entities: ${status.entityCount}`
    : "Engine stopped";

  return [
    { label: statusLine, action: "tray:status", enabled: false },
    { type: "separator" },
    { label: "Show Window", action: "tray:show" },
    { type: "separator" },
    { label: "Quit", action: "tray:quit" },
  ];
}

function updateTrayMenu(app: AppContext): void {
  tray?.setMenu(buildTrayMenu(app) as any);
}

function updateTray(app: AppContext): void {
  if (!tray) return;

  const status = app.engineHost?.getStatus();
  const isActive = status?.running && status.agentCount > 0;

  tray.setImage(
    isActive ? "resources/tray-icon-active.png" : "resources/tray-icon.png",
  );

  const title = status?.running
    ? `${status.agentCount} agent${status.agentCount !== 1 ? "s" : ""}`
    : "Idle";
  tray.setTitle(title);

  updateTrayMenu(app);
}

/**
 * Clean up tray resources.
 */
export function destroyTray(): void {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  if (tray) {
    tray.remove();
    tray = null;
  }
}
