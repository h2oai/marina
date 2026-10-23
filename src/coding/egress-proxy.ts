// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-destination network policy for container runs, enforced inside the
 * Marina process — no sidecar, no extra program. The container gets no
 * network of its own (podman `pasta --splice-only`: loopback only) except one
 * forwarded port, where this proxy listens for the duration of the run. Every
 * connection names its destination (`CONNECT host:port`, or an absolute
 * `http://` request); it passes only when the operator's allowlist names it
 * and the address it resolves to is public (the SSRF guard), and the upstream
 * connection is pinned to the address that was checked. Everything else gets a
 * readable `403` and is recorded as a denial for the run's output.
 */

import { createServer, type Server, type Socket, connect as tcpConnect } from "node:net";
import { resolveGuardedHost } from "../net/url-guard";

/** One allowlist entry: `host`, `host:port`, `*.domain` or `*.domain:port`. */
export interface EgressRule {
  host: string;
  /** `*.domain`: any subdomain of `host` (not `host` itself). */
  wildcard: boolean;
  /** Absent: the web ports, 80 and 443. */
  port?: number;
}

const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const WEB_PORTS = [80, 443];

/** Parse `MARINA_CODE_CONTAINER_EGRESS` (comma- or space-separated). Throws on a malformed entry. */
export function parseEgressRules(raw: string): EgressRule[] {
  const rules: EgressRule[] = [];
  for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
    const match = /^(\*\.)?([^:]+)(?::(\d{1,5}))?$/.exec(entry.toLowerCase());
    const host = match?.[2];
    const port = match?.[3] === undefined ? undefined : Number(match[3]);
    if (!match || !host || !HOST.test(host) || (port !== undefined && (port < 1 || port > 65_535)))
      throw new Error(
        `Invalid egress rule "${entry}": use host, host:port, *.domain or *.domain:port`,
      );
    rules.push({ host, wildcard: match[1] !== undefined, ...(port ? { port } : {}) });
  }
  return rules;
}

export function formatEgressRule(rule: EgressRule): string {
  return `${rule.wildcard ? "*." : ""}${rule.host}${rule.port ? `:${rule.port}` : ""}`;
}

/** Whether `host:port` is named by any rule. */
export function egressAllowed(rules: readonly EgressRule[], host: string, port: number): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return rules.some((rule) => {
    const ports = rule.port ? [rule.port] : WEB_PORTS;
    if (!ports.includes(port)) return false;
    return rule.wildcard ? name.endsWith(`.${rule.host}`) : name === rule.host;
  });
}

export interface EgressDenial {
  host: string;
  port: number;
  reason: string;
  /** Refused only for not being listed (a person may allow it); false: the address guard refused it. */
  approvable: boolean;
}

/** The parsed head of a proxy request. */
interface ProxyRequest {
  connect: boolean;
  host: string;
  port: number;
  /** For a plain-HTTP request: the head rewritten to origin form, `Connection: close`. */
  head?: string;
  /** Plain HTTP: the request line's parts and the headers kept (no proxy/connection ones). */
  method?: string;
  path?: string;
  version?: string;
  headers?: string[];
}

/**
 * The reserved host a container uses for Marina's own model API
 * (`http://marina.model/v1`). It exists only inside this proxy: requests to it
 * go to Marina's loopback `/v1` with a run key the proxy adds, so the
 * container never holds a provider key — or even Marina's key.
 */
export const MARINA_MODEL_HOST = "marina.model";

const MAX_HEAD_BYTES = 16 * 1024;
const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_CONNECTIONS = 64;
const MAX_DENIALS_KEPT = 50;

/** Parse a request head (`…\r\n\r\n` excluded). `undefined`: not a request this proxy serves. */
export function parseProxyRequest(head: string): ProxyRequest | undefined {
  const [requestLine = "", ...headers] = head.split("\r\n");
  const [method, target, version] = requestLine.split(" ");
  if (!method || !target || !version?.startsWith("HTTP/")) return undefined;
  if (method.toUpperCase() === "CONNECT") {
    const match = /^(?:\[([0-9a-f:.]+)\]|([^:[\]]+)):(\d{1,5})$/i.exec(target);
    const port = Number(match?.[3]);
    const host = match?.[1] ?? match?.[2];
    if (!host || !(port >= 1 && port <= 65_535)) return undefined;
    return { connect: true, host: host.toLowerCase(), port };
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  // HTTPS goes through CONNECT; an absolute https:// request would ask the proxy to speak TLS.
  if (url.protocol !== "http:" || url.username || url.password) return undefined;
  const kept = headers.filter(
    (line) => line && !/^(proxy-[a-z-]*|connection|keep-alive)\s*:/i.test(line),
  );
  const rewritten = [
    `${method} ${url.pathname}${url.search} ${version}`,
    ...kept,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  return {
    connect: false,
    host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    port: url.port ? Number(url.port) : 80,
    head: rewritten,
    method,
    path: `${url.pathname}${url.search}`,
    version,
    headers: kept,
  };
}

/**
 * The head of a `marina.model` request as Marina's `/v1` receives it: origin
 * form, Host set to the loopback listener, the caller's Authorization dropped
 * and the run key's put in its place.
 */
export function marinaModelHead(request: ProxyRequest, port: number, token: string): string {
  const headers = (request.headers ?? []).filter(
    (line) => !/^(authorization|x-api-key|host)\s*:/i.test(line),
  );
  return [
    `${request.method} ${request.path} ${request.version}`,
    `Host: 127.0.0.1:${port}`,
    `Authorization: Bearer ${token}`,
    ...headers,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
}

export interface EgressProxyOptions {
  /** Address check and pinning (default: the SSRF guard). Tests stub it. */
  resolve?: (host: string, port: number) => Promise<{ address: string } | { error: string }>;
  /** Marina's own `/v1` (loopback port) and the run key to present there, when offered. */
  marinaModel?: { port: number; token: string };
}

/** One run's proxy: start it, hand its port to the container, close it after. */
export class EgressProxy {
  readonly denials: EgressDenial[] = [];
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    readonly port: number,
  ) {}

  static async start(
    rules: readonly EgressRule[],
    opts: EgressProxyOptions = {},
  ): Promise<EgressProxy> {
    const resolve = opts.resolve ?? resolveGuardedHost;
    let proxy: EgressProxy | undefined;
    const server = createServer((client) =>
      proxy?.handle(client, rules, resolve, opts.marinaModel),
    );
    server.maxConnections = MAX_CONNECTIONS;
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => done());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Egress proxy has no port.");
    proxy = new EgressProxy(server, address.port);
    return proxy;
  }

  /** Stop listening and drop every open connection. */
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.once("close", () => this.sockets.delete(socket));
    // A reset peer is an ordinary end of a proxied connection; `close` cleans up.
    socket.on("error", () => {});
  }

  private deny(
    client: Socket,
    host: string,
    port: number,
    reason: string,
    approvable: boolean,
  ): void {
    if (this.denials.length < MAX_DENIALS_KEPT)
      this.denials.push({ host, port, reason, approvable });
    const body = `marina egress: ${host}:${port} blocked — ${reason}\n`;
    client.end(
      `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  }

  private handle(
    client: Socket,
    rules: readonly EgressRule[],
    resolve: NonNullable<EgressProxyOptions["resolve"]>,
    marinaModel: EgressProxyOptions["marinaModel"],
  ): void {
    this.track(client);
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > MAX_HEAD_BYTES)
          client.end("HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n");
        return;
      }
      client.off("data", onData);
      client.pause();
      const request = parseProxyRequest(buffered.subarray(0, end).toString("latin1"));
      const rest = buffered.subarray(end + 4);
      if (!request) {
        client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      if (request.host === MARINA_MODEL_HOST) this.toMarina(client, request, rest, marinaModel);
      else void this.forward(client, request, rest, rules, resolve);
    };
    client.on("data", onData);
  }

  /** `http://marina.model/v1/…` → Marina's loopback `/v1` with the run key; nothing else there. */
  private toMarina(
    client: Socket,
    request: ProxyRequest,
    rest: Buffer,
    marinaModel: EgressProxyOptions["marinaModel"],
  ): void {
    const host = MARINA_MODEL_HOST;
    if (!marinaModel) {
      this.deny(
        client,
        host,
        request.port,
        "Marina's model API is not offered to this runner",
        false,
      );
      return;
    }
    if (request.connect || !request.path?.startsWith("/v1/")) {
      this.deny(
        client,
        host,
        request.port,
        "only plain-HTTP /v1/ requests reach Marina's model API",
        false,
      );
      return;
    }
    const upstream = tcpConnect({ host: "127.0.0.1", port: marinaModel.port });
    this.track(upstream);
    upstream.once("error", () => {
      if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    upstream.once("connect", () => {
      upstream.write(marinaModelHead(request, marinaModel.port, marinaModel.token), "latin1");
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  }

  private async forward(
    client: Socket,
    request: ProxyRequest,
    rest: Buffer,
    rules: readonly EgressRule[],
    resolve: NonNullable<EgressProxyOptions["resolve"]>,
  ): Promise<void> {
    const { host, port } = request;
    if (!egressAllowed(rules, host, port)) {
      this.deny(client, host, port, "not in this runner's egress allowlist", true);
      return;
    }
    const checked = await resolve(host, port);
    if ("error" in checked) {
      this.deny(client, host, port, checked.error, false);
      return;
    }
    const upstream = tcpConnect({ host: checked.address, port });
    this.track(upstream);
    upstream.once("error", () => {
      if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    upstream.once("connect", () => {
      if (request.connect) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      else upstream.write(request.head!, "latin1");
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  }
}

/** One readable line per denied destination, for the run's output. */
export function formatEgressDenials(denials: readonly EgressDenial[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const denial of denials) {
    const key = `${denial.host}:${denial.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`[marina egress] blocked ${key}: ${denial.reason}`);
  }
  if (lines.length)
    lines.push(
      "[marina egress] Allowed destinations are the operator's MARINA_CODE_CONTAINER_EGRESS list plus any a person approved for this session.",
    );
  return lines.join("\n");
}

/** One entry per refused host:port, for the run result. */
export function distinctDenials(
  denials: readonly EgressDenial[],
): { host: string; port: number; approvable: boolean }[] {
  const byKey = new Map<string, { host: string; port: number; approvable: boolean }>();
  for (const d of denials) {
    const key = `${d.host}:${d.port}`;
    const seen = byKey.get(key);
    // A destination the guard refused even once is never approvable.
    byKey.set(key, {
      host: d.host,
      port: d.port,
      approvable: (seen?.approvable ?? true) && d.approvable,
    });
  }
  return [...byKey.values()];
}
