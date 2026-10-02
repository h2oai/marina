#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

/** Bound the runner itself as well as individual tests. A deadline is a failure,
 * never a successful forced exit. Preserve streaming output and the last test. */
export async function runTestProcess(argv: string[], deadlineMs = 900_000): Promise<number> {
  const started = Date.now();
  let lastTest = "test discovery";
  let completed = 0;
  let closedDatabaseWarnings = 0;
  let expired = false;
  const grouped = process.platform !== "win32";
  const child = spawn(argv[0]!, argv.slice(1), {
    stdio: ["inherit", "pipe", "pipe"],
    detached: grouped,
  });
  const stop = (signal: NodeJS.Signals) => {
    try {
      if (grouped && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  let force: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    expired = true;
    console.error(
      `Test runner deadline (${deadlineMs}ms) exceeded; last file: ${lastTest}. Inspect its teardown and child processes.`,
    );
    stop("SIGTERM");
    force = setTimeout(() => stop("SIGKILL"), 5000);
  }, deadlineMs);
  const heartbeat = setInterval(() => {
    console.error(
      `Test progress: ${completed} results, ${Math.round((Date.now() - started) / 1000)}s, latest file: ${lastTest}`,
    );
  }, 30_000);
  function forward(stream: Readable, destination: NodeJS.WriteStream) {
    let partial = "";
    function observe(line: string) {
      if (/^test\/.*\.test\.ts:$/.test(line)) lastTest = line.slice(0, -1);
      if (/^\((pass|fail|skip)\)/.test(line)) completed++;
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
    return expired ? 124 : code || (closedDatabaseWarnings ? 1 : 0);
  } finally {
    clearTimeout(deadline);
    clearTimeout(force);
    clearInterval(heartbeat);
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
