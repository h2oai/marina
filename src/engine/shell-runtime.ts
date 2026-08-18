// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MarinaDB } from "../persistence/database";
import { getErrorMessage } from "./errors";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExecResult {
  exitCode: number;
  preview: string;
  outputFile: string;
  truncated: boolean;
  timedOut: boolean;
  newFiles: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_PREVIEW_BYTES = 4096;
const MAX_PREVIEW_LINES = 200;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const RATE_LIMIT_MS = 5_000;

const SHELL_METACHARACTERS = /[;&|`$()><\n\r\\]/;

const CURATED_ENV: Record<string, string> = {
  TERM: "dumb",
  LANG: "en_US.UTF-8",
};

// ─── Shell Runtime ──────────────────────────────────────────────────────────

export class ShellRuntime {
  private db?: MarinaDB;
  private scratchRoot: string;
  private lastCall = new Map<string, number>();
  private lastExec = new Map<string, ExecResult>();

  constructor(db?: MarinaDB, scratchRoot = "data/scratch") {
    this.db = db;
    this.scratchRoot = scratchRoot;
  }

  /** Create scratch root on startup. */
  init(): void {
    if (!existsSync(this.scratchRoot)) {
      mkdirSync(this.scratchRoot, { recursive: true });
    }
  }

  /** Get the scratch directory for an entity (creates on demand). */
  scratchDir(entityId: string): string {
    const dir = join(this.scratchRoot, entityId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /** Get the last execution result for an entity. */
  getLastExec(entityId: string): ExecResult | undefined {
    return this.lastExec.get(entityId);
  }

  /** List files in an entity's scratch dir. */
  listScratch(entityId: string): string[] {
    const dir = this.scratchDir(entityId);
    try {
      return readdirSync(dir);
    } catch {
      // Expected: directory may not exist yet
      return [];
    }
  }

  /** Read a file from an entity's scratch dir (confined). */
  async readScratchFile(entityId: string, filename: string): Promise<string | null> {
    if (filename.includes("..") || filename.includes("/")) return null;
    const path = join(this.scratchDir(entityId), filename);
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return file.text();
  }

  /** Get a scratch file as bytes (for asset upload). */
  async readScratchFileBytes(
    entityId: string,
    filename: string,
  ): Promise<{ data: Uint8Array; size: number } | null> {
    if (filename.includes("..") || filename.includes("/")) return null;
    const path = join(this.scratchDir(entityId), filename);
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const data = new Uint8Array(await file.arrayBuffer());
    return { data, size: data.byteLength };
  }

  /** Delete a file from an entity's scratch dir (confined). */
  deleteScratchFile(entityId: string, filename: string): boolean {
    if (filename.includes("..") || filename.includes("/")) return false;
    const path = join(this.scratchDir(entityId), filename);
    try {
      const { unlinkSync } = require("node:fs");
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Execute a command (normal mode — no shell expansion). */
  async exec(
    entityId: string,
    binary: string,
    args: string[],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ExecResult> {
    // Block absolute/relative paths in binary name
    if (binary.includes("/") || binary.includes("\\")) {
      throw new Error("Binary paths are not allowed. Use the binary name only.");
    }

    // Allowlist check
    if (!this.isAllowed(binary)) {
      throw new Error(
        `"${binary}" is not in the shell allowlist. Use "shell list" to see allowed commands.`,
      );
    }

    // Block metacharacters in args
    for (const arg of args) {
      if (SHELL_METACHARACTERS.test(arg)) {
        throw new Error(`Shell metacharacters are not allowed in arguments: ${arg}`);
      }
    }

    // Rate limit (after validation so invalid requests don't consume tokens)
    const now = Math.max(Date.now(), 0);
    const last = this.lastCall.get(entityId);
    if (last !== undefined && now - last < RATE_LIMIT_MS) {
      throw new Error("Rate limited. Wait before running again.");
    }
    this.lastCall.set(entityId, now);

    const cwd = this.scratchDir(entityId);
    const timeout = Math.min(timeoutMs, MAX_TIMEOUT_MS);

    return this.spawn(entityId, [binary, ...args], cwd, timeout, false);
  }

  /** Execute a command in raw mode (shell expansion, admin only). */
  async execRaw(
    entityId: string,
    commandString: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ExecResult> {
    // Rate limit
    const now = Math.max(Date.now(), 0);
    const last = this.lastCall.get(entityId);
    if (last !== undefined && now - last < RATE_LIMIT_MS) {
      throw new Error("Rate limited. Wait before running again.");
    }
    this.lastCall.set(entityId, now);

    const cwd = this.scratchDir(entityId);
    const timeout = Math.min(timeoutMs, MAX_TIMEOUT_MS);

    return this.spawn(entityId, ["sh", "-c", commandString], cwd, timeout, true);
  }

  /** Check if a binary is in the allowlist. */
  isAllowed(binary: string): boolean {
    if (!this.db) return false;
    return this.db.isShellAllowed(binary);
  }

  /** Get the full allowlist. */
  getAllowlist(): string[] {
    if (!this.db) return [];
    return this.db.getShellAllowlist();
  }

  /** Add a binary to the allowlist. */
  allow(binary: string, addedBy: string): void {
    this.db?.addToShellAllowlist(binary, addedBy);
  }

  /** Remove a binary from the allowlist. */
  deny(binary: string): boolean {
    return this.db?.removeFromShellAllowlist(binary) ?? false;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private async spawn(
    entityId: string,
    cmd: string[],
    cwd: string,
    timeoutMs: number,
    raw: boolean,
  ): Promise<ExecResult> {
    // Snapshot scratch dir before execution
    const filesBefore = new Set(this.listScratch(entityId));

    // Build curated environment
    const env: Record<string, string> = {
      ...CURATED_ENV,
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: cwd,
    };

    let timedOut = false;
    let exitCode = -1;
    let stdout = "";
    let stderr = "";

    try {
      const proc = Bun.spawn(cmd, {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        proc.exited,
        new Promise<"timeout">((resolve) => {
          timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);
      if (timeoutTimer) clearTimeout(timeoutTimer); // don't leak the timer on the fast-exit path

      if (result === "timeout") {
        timedOut = true;
        proc.kill(); // SIGTERM
        // Escalate to SIGKILL if the child ignores/traps SIGTERM and doesn't
        // exit within a short grace window — otherwise `await proc.exited`
        // could hang forever, defeating the timeout we just enforced.
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const exitedInGrace = await Promise.race([
          proc.exited.then(() => true),
          new Promise<boolean>((resolve) => {
            graceTimer = setTimeout(() => resolve(false), 3000);
          }),
        ]);
        if (graceTimer) clearTimeout(graceTimer);
        if (!exitedInGrace) {
          proc.kill("SIGKILL");
          await proc.exited;
        }
      }

      exitCode = proc.exitCode ?? -1;
      stdout = await new Response(proc.stdout).text();
      stderr = await new Response(proc.stderr).text();
    } catch (err) {
      stderr = getErrorMessage(err);
      exitCode = 127;
    }

    // Write full output to file
    const outputFilename = `output-${Math.max(Date.now(), 0)}.txt`;
    const outputPath = join(cwd, outputFilename);
    const fullOutput = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
    await Bun.write(outputPath, fullOutput);

    // Build preview (truncated for display)
    const preview = truncatePreview(stdout, stderr);

    // Detect new files
    const filesAfter = this.listScratch(entityId);
    const newFiles = filesAfter.filter((f) => !filesBefore.has(f) && f !== outputFilename);

    const execResult: ExecResult = {
      exitCode,
      preview,
      outputFile: outputFilename,
      truncated: stdout.length > MAX_PREVIEW_BYTES || stdout.split("\n").length > MAX_PREVIEW_LINES,
      timedOut,
      newFiles,
    };

    // Store last exec for `shell save`
    this.lastExec.set(entityId, execResult);

    // Log to DB
    const binaryName = raw ? "sh" : (cmd[0] ?? "unknown");
    const argsStr = raw ? (cmd[2] ?? "") : cmd.slice(1).join(" ");
    this.db?.logShellExec(entityId, binaryName, argsStr, exitCode, fullOutput.length);

    return execResult;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncatePreview(stdout: string, stderr: string): string {
  const lines = stdout.split("\n");
  let preview: string;
  let truncated = false;

  if (lines.length > MAX_PREVIEW_LINES) {
    preview = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
    truncated = true;
  } else if (stdout.length > MAX_PREVIEW_BYTES) {
    preview = stdout.slice(0, MAX_PREVIEW_BYTES);
    truncated = true;
  } else {
    preview = stdout;
  }

  if (truncated) {
    const remaining = lines.length - MAX_PREVIEW_LINES;
    if (remaining > 0) {
      preview += `\n... ${remaining} more lines`;
    }
  }

  // Append stderr summary if present
  if (stderr.trim()) {
    const stderrLines = stderr.trim().split("\n");
    if (stderrLines.length <= 5) {
      preview += `\n[stderr] ${stderr.trim()}`;
    } else {
      preview += `\n[stderr] ${stderrLines.slice(0, 3).join("\n")}\n... ${stderrLines.length - 3} more lines`;
    }
  }

  return preview;
}
