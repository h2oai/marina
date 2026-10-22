#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

/** One row of `ps` output. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  stat: string;
  cpu: number;
  elapsed: string;
  args: string;
}

export interface RunnerOptions {
  /** Whole-run bound (default 900 s): the run fails with 124 when it passes. */
  deadlineMs?: number;
  /** No output from the run for this long is a stall (default 240 s; 0 = off).
   *  Above the largest per-test timeout in the suite (180 s), so a slow test
   *  that still ends within its own timeout never trips it. */
  inactivityMs?: number;
  /** A child process that exited but was not reaped by its parent for this
   *  long is a stall (default 60 s; 0 = off). A healthy parent reaps at once;
   *  one that does not is blocked in a synchronous call such as a stuck
   *  `Bun.spawnSync`, where no test timeout can fire. */
  unreapedMs?: number;
  /** How often the watchdog checks (default 30 s). */
  checkEveryMs?: number;
  /** Process listing; injected by tests. Resolves to undefined where `ps` is unavailable. */
  listProcesses?: () => Promise<ProcessRow[] | undefined>;
}

const DEFAULTS = {
  deadlineMs: 900_000,
  inactivityMs: 240_000,
  unreapedMs: 60_000,
  checkEveryMs: 30_000,
};

/** The test file a reporter line names, or undefined. Bun prefixes file
 *  headers with `##[group]` under GitHub Actions. */
export function testFileHeader(line: string): string | undefined {
  return /^(?:##\[group\])?(\S+\.test\.[cm]?[jt]sx?):$/.exec(line.trim())?.[1];
}

/** A file Bun lists after `Interrupted while still running:`, or undefined. */
export function interruptedFile(line: string): string | undefined {
  return /^\s+(\S+\.test\.[cm]?[jt]sx?) \(\d+s\)$/.exec(line)?.[1];
}

/** Parse `ps -A -o pid=,ppid=,stat=,pcpu=,etime=,args=`. */
export function parsePs(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\S+)\s?(.*)$/.exec(line);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      stat: m[3]!,
      cpu: Number(m[4]),
      elapsed: m[5]!,
      args: m[6] ?? "",
    });
  }
  return rows;
}

/** `root` and every descendant, parents before children, with their depth. */
export function processTree(
  rows: ProcessRow[],
  root: number,
): { row: ProcessRow; depth: number }[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const out: { row: ProcessRow; depth: number }[] = [];
  const seen = new Set<number>([root]);
  const self = rows.find((r) => r.pid === root);
  if (self) out.push({ row: self, depth: 0 });
  const walk = (pid: number, depth: number) => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push({ row: child, depth });
      walk(child.pid, depth + 1);
    }
  };
  walk(root, self ? 1 : 0);
  return out;
}

const exitedUnreaped = (row: ProcessRow) => row.stat.startsWith("Z");

/** The tree as indented lines; exited-but-unreaped children and busy processes are marked. */
export function formatProcessTree(tree: { row: ProcessRow; depth: number }[]): string[] {
  return tree.map(({ row, depth }) => {
    const notes = [
      exitedUnreaped(row) ? "exited, not reaped by its parent" : "",
      row.cpu >= 50 ? "busy" : "",
    ].filter(Boolean);
    const args = row.args.length > 200 ? `${row.args.slice(0, 200)}…` : row.args;
    return `${"  ".repeat(depth + 1)}${row.pid} ${row.stat} ${row.cpu}% ${row.elapsed} ${args}${
      notes.length ? `  [${notes.join("; ")}]` : ""
    }`;
  });
}

/** Every process, via `ps`; undefined where it is unavailable. */
export function listProcessesWithPs(): Promise<ProcessRow[] | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,stat=,pcpu=,etime=,args="],
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : parsePs(stdout)),
    );
  });
}

/** Bound the runner itself as well as individual tests. A deadline or a stall
 * is a failure, never a successful forced exit. Preserve streaming output and
 * name what was still running: the files Bun reports and the live processes. */
export async function runTestProcess(
  argv: string[],
  options: number | RunnerOptions = {},
): Promise<number> {
  const opts = {
    ...DEFAULTS,
    ...(typeof options === "number" ? { deadlineMs: options } : options),
  };
  const listProcesses = opts.listProcesses ?? listProcessesWithPs;
  const started = Date.now();
  let lastOutputAt = started;
  let lastTest = "test discovery";
  let completed = 0;
  let closedDatabaseWarnings = 0;
  let failure: string | undefined;
  let checking = false;
  const interrupted: string[] = [];
  let inInterruptedList = false;
  const unreapedSince = new Map<number, number>();
  const grouped = process.platform !== "win32";
  const child = spawn(argv[0]!, argv.slice(1), {
    stdio: ["inherit", "pipe", "pipe"],
    detached: grouped,
  });
  const signal = (pid: number, sig: NodeJS.Signals, group: boolean) => {
    try {
      process.kill(group ? -pid : pid, sig);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const stop = (sig: NodeJS.Signals) => {
    if (grouped && child.pid) signal(child.pid, sig, true);
    else child.kill(sig);
  };
  /** Live descendants of the run, or undefined when they cannot be listed. */
  const liveTree = async () => {
    const rows = child.pid ? await listProcesses() : undefined;
    return rows && child.pid ? processTree(rows, child.pid) : undefined;
  };
  let force: ReturnType<typeof setTimeout> | undefined;
  /** Report what is still running, then stop the run. Bun's test workers run in
   *  their own process groups, so the forced stop signals every descendant. */
  const fail = async (reason: string) => {
    if (failure) return;
    failure = reason;
    const tree = await liveTree();
    console.error(`Test runner: ${reason}; last file reported: ${lastTest}.`);
    if (tree) {
      console.error("Live processes under the test run (pid stat cpu elapsed args):");
      for (const line of formatProcessTree(tree)) console.error(line);
      if (tree.some(({ row }) => exitedUnreaped(row)))
        console.error(
          "A process whose child exited without being reaped is blocked in a synchronous call (for example Bun.spawnSync or execFileSync); no test timeout can fire while it is.",
        );
    } else console.error("Live processes: listing unavailable on this platform.");
    stop("SIGTERM");
    force = setTimeout(() => {
      stop("SIGKILL");
      for (const { row } of tree ?? []) signal(row.pid, "SIGKILL", false);
    }, 5000);
  };
  const deadline = setTimeout(() => {
    void fail(
      `deadline (${opts.deadlineMs}ms) exceeded. Inspect the teardown and child processes of the files still running`,
    );
  }, opts.deadlineMs);
  const check = async () => {
    if (failure || checking) return;
    const now = Date.now();
    console.error(
      `Test progress: ${completed} results, ${Math.round((now - started) / 1000)}s, latest file: ${lastTest}, last output ${Math.round((now - lastOutputAt) / 1000)}s ago`,
    );
    if (opts.inactivityMs > 0 && now - lastOutputAt >= opts.inactivityMs) {
      await fail(
        `no output for ${Math.round((now - lastOutputAt) / 1000)}s (limit ${opts.inactivityMs}ms); the run is stalled`,
      );
      return;
    }
    if (opts.unreapedMs <= 0) return;
    checking = true;
    try {
      const tree = await liveTree();
      if (!tree || failure) return;
      const zombies = tree.filter(({ row }) => exitedUnreaped(row)).map(({ row }) => row);
      for (const pid of unreapedSince.keys())
        if (!zombies.some((z) => z.pid === pid)) unreapedSince.delete(pid);
      for (const zombie of zombies) {
        const since = unreapedSince.get(zombie.pid) ?? now;
        unreapedSince.set(zombie.pid, since);
        if (now - since >= opts.unreapedMs) {
          await fail(
            `process ${zombie.ppid} has not reaped its exited child ${zombie.pid} for ${Math.round((now - since) / 1000)}s (limit ${opts.unreapedMs}ms); it is stuck`,
          );
          return;
        }
      }
    } finally {
      checking = false;
    }
  };
  const watchdog = setInterval(() => void check(), opts.checkEveryMs);
  function forward(stream: Readable, destination: NodeJS.WriteStream) {
    let partial = "";
    function observe(line: string) {
      const file = testFileHeader(line);
      if (file) lastTest = file;
      if (/^\((pass|fail|skip)\)/.test(line)) completed++;
      if (/^Interrupted while still running:/.test(line)) inInterruptedList = true;
      else if (inInterruptedList) {
        const stalled = interruptedFile(line);
        if (stalled) interrupted.push(stalled);
        else inInterruptedList = false;
      }
      if (
        /DB log failed|Activity tracking failed|Primitive usage recording failed|Daily spend not recorded|Judge observation not recorded/.test(
          line,
        ) &&
        /Cannot use a closed database|Database has closed/.test(line)
      )
        closedDatabaseWarnings++;
    }
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      lastOutputAt = Date.now();
      destination.write(chunk);
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) observe(line);
    });
    stream.on("end", () => {
      if (partial) observe(partial);
    });
  }
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
    if (closedDatabaseWarnings)
      console.error(
        `Test runner observed ${closedDatabaseWarnings} closed-database lifecycle warnings. Await command and adapter teardown before closing persistence.`,
      );
    if (failure)
      console.error(
        `Test runner stopped the run: ${failure}.${interrupted.length ? ` Still running: ${interrupted.join(", ")}.` : ""}`,
      );
    return failure ? 124 : code || (closedDatabaseWarnings ? 1 : 0);
  } finally {
    clearTimeout(deadline);
    clearTimeout(force);
    clearInterval(watchdog);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

if (import.meta.main) {
  process.chdir(resolve(import.meta.dir, ".."));
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const parallel = args.some((arg) => arg.startsWith("--parallel")) ? [] : ["--parallel=4"];
  const timeout = args.some((arg) => arg.startsWith("--timeout")) ? [] : ["--timeout=15000"];
  process.exit(await runTestProcess([process.execPath, "test", ...parallel, ...timeout, ...args]));
}
