// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The dashboard is built for you. A source checkout serves `dist/dashboard`,
 * which `bun run dashboard:build` used to have to produce by hand — so a person
 * who started with the `marina` CLI followed a dashboard link to a "not built
 * yet" page. On boot the server now builds it in the background when it is
 * missing or older than its sources (`dashboard/` and the `src/` it imports):
 * about a second. The build goes to a temporary folder that replaces
 * `dist/dashboard` only when complete, so a page being served never sees half
 * a build, and a lock keeps two Marinas on one checkout from building at once.
 *
 * Nothing happens for a compiled binary or an install without the dashboard
 * sources, and `MARINA_DASHBOARD_AUTOBUILD=off` turns it off.
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { getErrorMessage } from "../engine/errors";
import type { Logger } from "../engine/logger";
import { bunExecutable, IS_COMPILED, MARINA_ROOT } from "../runtime-paths";

export type DashboardBuildState = "fresh" | "missing" | "stale" | "unavailable";

/** A lock older than this belongs to a build that died; the next boot takes it over. */
const LOCK_STALE_MS = 5 * 60_000;
/** A build that has not finished by now is stopped. */
const BUILD_TIMEOUT_MS = 5 * 60_000;

export function dashboardAutobuildEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_DASHBOARD_AUTOBUILD?.trim().toLowerCase() !== "off";
}

/** The newest modification time of any file under `dir` (skipping dependency and build folders). */
function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          newest = Math.max(newest, statSync(p).mtimeMs);
        } catch {
          // A file removed mid-walk is no newer than the build.
        }
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * Whether the served dashboard needs a build: `unavailable` without the
 * sources (a compiled binary, a package without `dashboard/`), `missing` with
 * no build, `stale` when a source the bundle is made from changed after it.
 */
export function dashboardBuildState(root = MARINA_ROOT): DashboardBuildState {
  if (IS_COMPILED) return "unavailable";
  const sources = join(root, "dashboard");
  if (!existsSync(join(sources, "index.html")) || !existsSync(join(sources, "vite.config.ts")))
    return "unavailable";
  const index = join(root, "dist", "dashboard", "index.html");
  if (!existsSync(index)) return "missing";
  const built = statSync(index).mtimeMs;
  // The dashboard imports types and helpers from the root `src/` as well.
  const newest = Math.max(newestMtime(sources), newestMtime(join(root, "src")));
  return newest > built ? "stale" : "fresh";
}

function takeLock(path: string): boolean {
  try {
    closeSync(openSync(path, "wx"));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
        rmSync(path, { force: true });
        closeSync(openSync(path, "wx"));
        return true;
      }
    } catch {
      // Another process holds or just took it.
    }
    return false;
  }
}

/** Run `vite build` into `outDir`; resolves with the error text, or undefined on success. */
function viteBuild(root: string, outDir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(
      bunExecutable(),
      ["x", "vite", "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"],
      { cwd: join(root, "dashboard"), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), BUILD_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(getErrorMessage(err));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? undefined : stderr.trim() || `vite build exited with ${code}`);
    });
  });
}

/**
 * Build the dashboard when it is missing or stale. Never throws: a failed build
 * leaves whatever was served before and logs how to build it by hand.
 */
export async function ensureDashboardBuilt(
  logger: Logger,
  opts: { root?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<DashboardBuildState | "built" | "failed" | "busy" | "off"> {
  const root = opts.root ?? MARINA_ROOT;
  if (!dashboardAutobuildEnabled(opts.env)) return "off";
  const state = dashboardBuildState(root);
  if (state === "fresh" || state === "unavailable") return state;
  const dist = join(root, "dist");
  const lock = join(dist, ".dashboard-build.lock");
  try {
    mkdirSync(dist, { recursive: true });
  } catch {
    return "failed";
  }
  if (!takeLock(lock)) return "busy";
  const started = Date.now();
  const tmp = join(dist, `dashboard.build-${process.pid}`);
  const old = join(dist, `dashboard.old-${process.pid}`);
  try {
    const error = await viteBuild(root, tmp);
    if (error || !existsSync(join(tmp, "index.html"))) {
      rmSync(tmp, { recursive: true, force: true });
      logger.warn(
        "main",
        `Dashboard build failed — run \`bun run dashboard:build\` to see why: ${(error ?? "no index.html").split("\n").slice(-3).join(" ")}`,
      );
      return "failed";
    }
    const target = join(dist, "dashboard");
    if (existsSync(target)) renameSync(target, old);
    renameSync(tmp, target);
    rmSync(old, { recursive: true, force: true });
    logger.info(
      "main",
      `Dashboard ${state === "missing" ? "built" : "rebuilt"} in ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
    return "built";
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    logger.warn("main", `Dashboard build failed: ${getErrorMessage(err)}`);
    return "failed";
  } finally {
    rmSync(lock, { force: true });
  }
}
