// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { getErrorMessage } from "../engine/errors";

export type WireMessage = Record<string, unknown>;

/** JSONL framing deliberately splits only LF (pi permits Unicode line separators in JSON). */
export class JsonLines {
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  constructor(private readonly receive: (message: WireMessage) => void) {}
  push(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk);
    let end = this.buffer.indexOf("\n");
    while (end >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > 8_388_608) throw new Error("Native frame exceeds 8 MiB");
      if (line.trim()) {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Native protocol requires JSON objects");
        this.receive(value as WireMessage);
      }
      end = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer) > 8_388_608) throw new Error("Native frame exceeds 8 MiB");
  }
}

export class AgentTransport {
  private process: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (value: WireMessage) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  private stopping?: Promise<void>;
  private resolveExit!: () => void;
  private readonly exited = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });
  constructor(options: {
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    onMessage: (message: WireMessage) => void;
    onStderr: (text: string) => void;
    onExit: (error?: string) => void;
  }) {
    this.process = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
    });
    const finish = (error?: string) => {
      if (this.closed) return;
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(error ?? "Agent transport closed"));
      }
      this.pending.clear();
      options.onExit(error);
    };
    const lines = new JsonLines((message) => {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (pending && ("result" in message || "error" in message || message.type === "response")) {
        this.pending.delete(key);
        clearTimeout(pending.timer);
        if (message.error || message.success === false)
          pending.reject(new Error(JSON.stringify(message.error ?? message)));
        else pending.resolve(message);
      } else options.onMessage(message);
    });
    this.process.stdout.on("data", (chunk: Buffer) => {
      try {
        lines.push(chunk);
      } catch (error) {
        finish(getErrorMessage(error));
        void this.stop();
      }
    });
    this.process.stderr.on("data", (chunk: Buffer) => options.onStderr(chunk.toString("utf8")));
    this.process.stdin.on("error", (error) => finish(getErrorMessage(error)));
    this.process.on("error", (error) => finish(getErrorMessage(error)));
    this.process.on("close", (code, signal) => {
      finish(code === 0 ? undefined : `Agent exited (${signal ?? code})`);
      this.resolveExit();
    });
  }
  send(message: WireMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Agent transport closed"));
    return new Promise((resolve, reject) => {
      this.process.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
  request(message: WireMessage): Promise<WireMessage> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Native request timed out; acceptance is unknown"));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      void this.send({ ...message, id }).catch((error: Error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.process.stdin.end();
      this.process.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (this.process.exitCode === null && this.process.signalCode === null)
          this.process.kill("SIGKILL");
      }, 3000);
      await this.exited;
      clearTimeout(timer);
    })();
    return this.stopping;
  }
}
