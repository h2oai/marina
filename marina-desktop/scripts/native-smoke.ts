// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Run under xvfb-run on Linux. Launch the real package with isolated data,
// exercise the embedded server, then require a drained native shutdown.
if (process.platform !== "linux") throw new Error("Native smoke currently requires Linux/Xvfb");
const project = resolve(import.meta.dir, "..");
const builtLauncher = resolve(
  project,
  process.argv[2] ?? `build/dev-linux-${process.arch}/Marina-dev/bin/launcher`,
);
const isolated = mkdtempSync(resolve(project, "build/native-smoke-"));
const copiedApp = resolve(isolated, "app");
cpSync(resolve(dirname(builtLauncher), ".."), copiedApp, { recursive: true });
const launcher = resolve(copiedApp, "bin/launcher");
const view = resolve(copiedApp, "Resources/app/views/dashboard/index.html");
const probe = readFileSync(resolve(project, "test/fixtures/native-smoke-view.js"), "utf8");
writeFileSync(
  view,
  readFileSync(view, "utf8").replace("</body>", `<script>${probe}</script></body>`),
);
const data = resolve(isolated, "data/marina");
mkdirSync(data, { recursive: true });
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reservation.port!;
reservation.stop(true);
writeFileSync(
  resolve(data, "preferences.json"),
  JSON.stringify({ wsPort: port, telnetPort: 0, mcpPort: 0, world: "default" }),
);
const child = Bun.spawn([launcher], {
  cwd: dirname(launcher),
  env: {
    ...process.env,
    XDG_DATA_HOME: resolve(isolated, "data"),
    XDG_CONFIG_HOME: resolve(isolated, "config"),
    XDG_CACHE_HOME: resolve(isolated, "cache"),
    AGENT_AUTORESPAWN: "false",
    MARINA_TRUST_PROFILE: "local",
    GDK_BACKEND: "x11",
    LIBGL_ALWAYS_SOFTWARE: "1",
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    WEBKIT_DISABLE_COMPOSITING_MODE: "1",
  },
  detached: true,
  stdout: Bun.file(resolve(isolated, "stdout.log")),
  stderr: Bun.file(resolve(isolated, "stderr.log")),
});
const logs = () =>
  `${readFileSync(resolve(isolated, "stdout.log"), "utf8")}\n${readFileSync(resolve(isolated, "stderr.log"), "utf8")}`;
let socket: WebSocket | undefined;
async function until(predicate: () => boolean | Promise<boolean>, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Native app exited early: ${child.exitCode}`);
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error("Native smoke deadline exceeded");
}
try {
  await until(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }))
        .ok;
    } catch {
      return false;
    } // allow-empty-catch: app is still starting
  });
  const perceptions: string[] = [];
  console.log("Native embedded server is ready");
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.onmessage = (event) => perceptions.push(String(event.data));
  await until(() => socket?.readyState === WebSocket.OPEN);
  socket.send(JSON.stringify({ type: "login", name: "Desktop Smoke" }));
  await until(() => perceptions.some((message) => message.includes('"onboarding"')));
  console.log("Native participation login and onboarding passed");
  perceptions.length = 0;
  socket.send(JSON.stringify({ type: "command", command: "look", request_id: "native-look" }));
  await until(() =>
    perceptions.some(
      (message) => JSON.parse(message).data?.command_result?.request_id === "native-look",
    ),
  );
  if (!perceptions.some((message) => JSON.parse(message).data?.command_result?.ok === true))
    throw new Error("Native look command failed");
  await until(() => {
    if (logs().includes("[native-smoke] UI failed:"))
      throw new Error("Native UI probe failed; see native.log");
    return logs().includes("[native-smoke] UI and RPC passed");
  });
  if (Bun.which("import")) {
    const screenshot = Bun.spawn(["import", "-window", "root", resolve(isolated, "desktop.png")], {
      stdout: "ignore",
      stderr: "inherit",
    });
    if ((await screenshot.exited) !== 0) throw new Error("Native screenshot capture failed");
  }
  socket.close();
  // The native launcher waits for Bun but does not forward Unix signals.
  const children = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  if (children.length !== 1) throw new Error("Expected one native Bun child");
  process.kill(children[0]!, "SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exit = await Promise.race([
    child.exited,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Native shutdown timed out")), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (exit !== 0 || !logs().includes("Engine stopped."))
    throw new Error(`Native shutdown was not clean: ${exit}`);
  if (/\[ErrorBoundary\]|Fatal startup error|Failed to load room/.test(logs()))
    throw new Error("Native app reported a rendering or room-loading error");
  using db = new Database(resolve(data, "marina.db"), { readonly: true });
  if (
    db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !==
    "ok"
  )
    throw new Error("Native database integrity check failed");
  console.log(`Native desktop smoke passed. Evidence: ${isolated}`);
} finally {
  socket?.close();
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      console.error("Native process cleanup failed:", error);
      process.exitCode = 1;
    }
  }
  await child.exited;
  writeFileSync(resolve(isolated, "native.log"), logs());
  rmSync(copiedApp, { recursive: true, force: true });
  console.log(`Native smoke evidence: ${isolated}`);
}
