// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A minimal gRPC client over `node:http2` for OpenShell's gateway — unary and
 * server-streaming calls with length-prefixed protobuf frames, mutual TLS for
 * authentication, and the status read from trailers or (trailers-only error
 * replies) from the response headers. No dependency beyond the runtime.
 */

import { type ClientHttp2Session, connect, type SecureClientSessionOptions } from "node:http2";

export class GrpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "GrpcError";
  }
}

/** gRPC status codes this client distinguishes. */
export const GRPC_NOT_FOUND = 5;
export const GRPC_DEADLINE_EXCEEDED = 4;

export interface GrpcClientOptions {
  /** `https://host:port` (mTLS) — or `http://` on loopback, for tests only. */
  url: string;
  /** Fully qualified service, e.g. `openshell.v1.OpenShell`. */
  service: string;
  tls?: Pick<SecureClientSessionOptions, "ca" | "cert" | "key">;
}

export class GrpcClient {
  private session: ClientHttp2Session | undefined;

  constructor(private readonly opts: GrpcClientOptions) {
    const url = new URL(opts.url);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      throw new Error("The OpenShell gateway URL must be https (mutual TLS)");
  }

  private connection(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const session = connect(this.opts.url, { ...(this.opts.tls ?? {}) });
    // A failed session surfaces as an error on the stream that uses it.
    session.on("error", () => {});
    session.unref();
    this.session = session;
    return session;
  }

  close(): void {
    this.session?.close();
    this.session = undefined;
  }

  /** A unary call: exactly one reply message. */
  async unary(method: string, body: Uint8Array, timeoutMs = 60_000): Promise<Uint8Array> {
    const replies: Uint8Array[] = [];
    await this.stream(method, body, (m) => replies.push(m), { timeoutMs });
    const reply = replies[0];
    if (!reply) throw new GrpcError(13, `${method} returned no message`);
    return reply;
  }

  /**
   * A server-streaming call: `onMessage` runs for each reply message; the
   * promise settles with the call's final status. Aborting `signal` (or the
   * timeout) cancels the stream (`RST_STREAM`), which cancels it remotely.
   */
  stream(
    method: string,
    body: Uint8Array,
    onMessage: (message: Uint8Array) => void,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = this.connection().request({
        ":method": "POST",
        ":path": `/${this.opts.service}/${method}`,
        "content-type": "application/grpc",
        te: "trailers",
      });
      let buffered = Buffer.alloc(0);
      let status: string | undefined;
      let statusMessage = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => {
        stream.close();
        finish(new GrpcError(1, `${method} cancelled`));
      };
      const timer = setTimeout(() => {
        stream.close();
        finish(new GrpcError(GRPC_DEADLINE_EXCEEDED, `${method} exceeded ${opts.timeoutMs} ms`));
      }, opts.timeoutMs ?? 60_000);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const readStatus = (headers: Record<string, unknown>) => {
        if (headers["grpc-status"] !== undefined) status = String(headers["grpc-status"]);
        if (headers["grpc-message"] !== undefined)
          statusMessage = decodeURIComponent(String(headers["grpc-message"]));
      };
      stream.on("response", (headers) => readStatus(headers));
      stream.on("trailers", (trailers) => readStatus(trailers));
      stream.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 5) {
          if (buffered[0] !== 0) {
            stream.close();
            finish(new GrpcError(12, `${method}: compressed replies are not supported`));
            return;
          }
          const length = buffered.readUInt32BE(1);
          if (buffered.length < 5 + length) break;
          try {
            onMessage(new Uint8Array(buffered.subarray(5, 5 + length)));
          } catch (error) {
            stream.close();
            finish(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          buffered = buffered.subarray(5 + length);
        }
      });
      stream.on("error", (error) => finish(error));
      stream.on("close", () => {
        if (status === undefined) finish(new GrpcError(14, `${method}: no gRPC status`));
        else if (status !== "0")
          finish(new GrpcError(Number(status), statusMessage || `${method} failed (${status})`));
        else finish();
      });
      const frame = Buffer.alloc(5 + body.length);
      frame.writeUInt32BE(body.length, 1);
      frame.set(body, 5);
      stream.end(frame);
    });
  }
}
