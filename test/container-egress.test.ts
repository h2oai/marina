// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server, connect as tcpConnect } from "node:net";
import { containerRunArgv, resolveContainerRunner } from "../src/coding/container-workspace";
import {
  distinctDenials,
  EgressProxy,
  egressAllowed,
  formatEgressDenials,
  MARINA_MODEL_HOST,
  parseEgressRules,
  parseProxyRequest,
} from "../src/coding/egress-proxy";
import {
  effectiveRunner,
  envRunnerConfig,
  withEgressGrants,
} from "../src/engine/commands/code/runner";

const IMAGE = "docker.io/library/alpine:latest";
const fakeWhich = (present: string[]) => (binary: string) =>
  present.includes(binary) ? `/usr/bin/${binary}` : null;

describe("egress rules", () => {
  it("parses host, host:port and wildcard entries and refuses junk", () => {
    expect(parseEgressRules("registry.npmjs.org, *.pypi.org:443 github.com:22")).toEqual([
      { host: "registry.npmjs.org", wildcard: false },
      { host: "pypi.org", wildcard: true, port: 443 },
      { host: "github.com", wildcard: false, port: 22 },
    ]);
    for (const bad of ["http://x.com", "x.com:0", "x.com:70000", "*", "a b/c", "x..com"])
      expect(() => parseEgressRules(bad)).toThrow("Invalid egress rule");
  });

  it("matches exact hosts on the web ports, wildcards on subdomains only, and named ports", () => {
    const rules = parseEgressRules("registry.npmjs.org *.pypi.org:443 github.com:22");
    expect(egressAllowed(rules, "registry.npmjs.org", 443)).toBe(true);
    expect(egressAllowed(rules, "REGISTRY.npmjs.org.", 80)).toBe(true);
    expect(egressAllowed(rules, "registry.npmjs.org", 8443)).toBe(false);
    expect(egressAllowed(rules, "evil-registry.npmjs.org", 443)).toBe(false);
    expect(egressAllowed(rules, "files.pypi.org", 443)).toBe(true);
    expect(egressAllowed(rules, "pypi.org", 443)).toBe(false);
    expect(egressAllowed(rules, "files.pypi.org", 80)).toBe(false);
    expect(egressAllowed(rules, "github.com", 22)).toBe(true);
    expect(egressAllowed(rules, "github.com", 443)).toBe(false);
  });

  it("parses CONNECT and absolute http requests; refuses https absolute form and junk", () => {
    expect(parseProxyRequest("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443")).toEqual({
      connect: true,
      host: "example.com",
      port: 443,
    });
    expect(parseProxyRequest("CONNECT [2001:db8::1]:443 HTTP/1.1")).toMatchObject({
      host: "2001:db8::1",
      port: 443,
    });
    const plain = parseProxyRequest(
      "GET http://example.com:8080/a?b=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: x\r\nConnection: keep-alive",
    );
    expect(plain).toMatchObject({ connect: false, host: "example.com", port: 8080 });
    expect(plain?.head).toBe(
      "GET /a?b=1 HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n",
    );
    expect(parseProxyRequest("GET https://example.com/ HTTP/1.1")).toBeUndefined();
    expect(parseProxyRequest("GET /relative HTTP/1.1")).toBeUndefined();
    expect(parseProxyRequest("CONNECT example.com HTTP/1.1")).toBeUndefined();
  });
});

describe("EgressProxy", () => {
  let upstream: Server | undefined;
  let proxy: EgressProxy | undefined;
  afterEach(async () => {
    await proxy?.close();
    await new Promise<void>((done) => (upstream ? upstream.close(() => done()) : done()));
    proxy = undefined;
    upstream = undefined;
  });

  /** An upstream echoing what it receives, on a loopback port. */
  async function echoUpstream(): Promise<number> {
    upstream = createServer((socket) => socket.on("data", (chunk) => socket.write(chunk)));
    await new Promise<void>((done) => upstream!.listen(0, "127.0.0.1", () => done()));
    return (upstream!.address() as { port: number }).port;
  }

  /** Send `request` through the proxy and collect everything until `until` appears or close. */
  function exchange(port: number, request: string, until?: string): Promise<string> {
    return new Promise((done, fail) => {
      const socket = tcpConnect({ host: "127.0.0.1", port });
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (until && received.includes(until)) {
          socket.destroy();
          done(received);
        }
      });
      socket.on("close", () => done(received));
      socket.on("error", fail);
      socket.write(request);
    });
  }

  it("tunnels an allowed CONNECT to the pinned address and nothing else", async () => {
    const target = await echoUpstream();
    const resolved: string[] = [];
    proxy = await EgressProxy.start(parseEgressRules(`allowed.example:${target}`), {
      resolve: async (host) => {
        resolved.push(host);
        return { address: "127.0.0.1" };
      },
    });
    const reply = await exchange(
      proxy.port,
      `CONNECT allowed.example:${target} HTTP/1.1\r\nHost: allowed.example\r\n\r\nping`,
      "ping",
    );
    expect(reply).toBe("HTTP/1.1 200 Connection Established\r\n\r\nping");
    expect(resolved).toEqual(["allowed.example"]);
    expect(proxy.denials).toEqual([]);
  });

  it("refuses an unlisted destination and a guarded address, readably, and records both", async () => {
    proxy = await EgressProxy.start(parseEgressRules("allowed.example"), {
      resolve: async () => ({
        error: "Blocked host allowed.example — resolves to private/internal IP: 10.0.0.5",
      }),
    });
    const unlisted = await exchange(proxy.port, "CONNECT evil.example:443 HTTP/1.1\r\n\r\n");
    expect(unlisted).toStartWith("HTTP/1.1 403 Forbidden");
    expect(unlisted).toContain("evil.example:443 blocked — not in this runner's egress allowlist");
    const guarded = await exchange(proxy.port, "CONNECT allowed.example:443 HTTP/1.1\r\n\r\n");
    expect(guarded).toContain("resolves to private/internal IP");
    expect(proxy.denials.map((d) => `${d.host}:${d.port}`)).toEqual([
      "evil.example:443",
      "allowed.example:443",
    ]);
    expect(formatEgressDenials([...proxy.denials, ...proxy.denials])).toBe(
      [
        "[marina egress] blocked evil.example:443: not in this runner's egress allowlist",
        "[marina egress] blocked allowed.example:443: Blocked host allowed.example — resolves to private/internal IP: 10.0.0.5",
        "[marina egress] Allowed destinations are the operator's MARINA_CODE_CONTAINER_EGRESS list plus any a person approved for this session.",
      ].join("\n"),
    );
  });

  it("forwards a plain http request in origin form with Connection: close", async () => {
    const target = await echoUpstream();
    proxy = await EgressProxy.start(parseEgressRules(`allowed.example:${target}`), {
      resolve: async () => ({ address: "127.0.0.1" }),
    });
    const echoed = await exchange(
      proxy.port,
      `GET http://allowed.example:${target}/x HTTP/1.1\r\nHost: allowed.example\r\nProxy-Connection: keep-alive\r\n\r\n`,
      "\r\n\r\n",
    );
    expect(echoed).toBe("GET /x HTTP/1.1\r\nHost: allowed.example\r\nConnection: close\r\n\r\n");
  });
});

describe("Marina's model API through the proxy", () => {
  let marina: Server | undefined;
  let proxy: EgressProxy | undefined;
  afterEach(async () => {
    await proxy?.close();
    await new Promise<void>((done) => (marina ? marina.close(() => done()) : done()));
    proxy = undefined;
    marina = undefined;
  });

  /** A stand-in for Marina's loopback listener that records each request head. */
  async function fakeMarina(heads: string[]): Promise<number> {
    marina = createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString("latin1");
        if (!buffered.includes("\r\n\r\n")) return;
        heads.push(buffered.slice(0, buffered.indexOf("\r\n\r\n")));
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
      });
    });
    await new Promise<void>((done) => marina!.listen(0, "127.0.0.1", () => done()));
    return (marina!.address() as { port: number }).port;
  }

  function send(port: number, request: string): Promise<string> {
    return new Promise((done, fail) => {
      const socket = tcpConnect({ host: "127.0.0.1", port });
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString();
      });
      socket.on("close", () => done(received));
      socket.on("error", fail);
      socket.write(request);
    });
  }

  it("forwards /v1 to Marina with the run key in place of the caller's credential", async () => {
    const heads: string[] = [];
    const port = await fakeMarina(heads);
    proxy = await EgressProxy.start([], { marinaModel: { port, token: "mrk_secret" } });
    const reply = await send(
      proxy.port,
      `POST http://${MARINA_MODEL_HOST}/v1/chat/completions HTTP/1.1\r\nHost: ${MARINA_MODEL_HOST}\r\nAuthorization: Bearer stolen\r\nx-api-key: also-stolen\r\nContent-Length: 2\r\n\r\n{}`,
    );
    expect(reply).toEndWith("ok");
    expect(heads).toHaveLength(1);
    const head = heads[0]!;
    expect(head).toStartWith("POST /v1/chat/completions HTTP/1.1\r\n");
    expect(head).toContain(`Host: 127.0.0.1:${port}`);
    expect(head).toContain("Authorization: Bearer mrk_secret");
    expect(head).not.toContain("stolen");
    expect(proxy.denials).toEqual([]);
  });

  it("serves nothing but /v1, never over CONNECT, and only when offered", async () => {
    const heads: string[] = [];
    const port = await fakeMarina(heads);
    proxy = await EgressProxy.start(parseEgressRules(MARINA_MODEL_HOST), {
      marinaModel: { port, token: "mrk_secret" },
    });
    for (const request of [
      `GET http://${MARINA_MODEL_HOST}/v1/../api/ops/overview HTTP/1.1\r\n\r\n`,
      `GET http://${MARINA_MODEL_HOST}/v1\\..\\api HTTP/1.1\r\n\r\n`,
      `GET http://${MARINA_MODEL_HOST}/mem/notes HTTP/1.1\r\n\r\n`,
      `CONNECT ${MARINA_MODEL_HOST}:443 HTTP/1.1\r\n\r\n`,
    ])
      expect(await send(proxy.port, request)).toStartWith("HTTP/1.1 403 Forbidden");
    expect(heads).toEqual([]);
    expect(proxy.denials.every((d) => !d.approvable)).toBe(true);
    await proxy.close();
    // Not offered: an allowlist naming the host does not open it either.
    proxy = await EgressProxy.start(parseEgressRules(MARINA_MODEL_HOST));
    expect(
      await send(proxy.port, `GET http://${MARINA_MODEL_HOST}/v1/models HTTP/1.1\r\n\r\n`),
    ).toContain("not offered to this runner");
  });
});

describe("container egress policy", () => {
  it("runs a podman allowlist on loopback plus the proxy port, with proxy variables", () => {
    const runner = resolveContainerRunner(
      { image: IMAGE, egress: parseEgressRules("registry.npmjs.org") },
      {},
      fakeWhich(["podman"]),
    );
    expect(() => containerRunArgv(runner, "/repo", ["true"], "n")).toThrow("no proxy port");
    const argv = containerRunArgv(runner, "/repo", ["true"], "n", { egressPort: 41234 });
    expect(argv[argv.indexOf("--network") + 1]).toBe("pasta:--splice-only,-T,41234");
    const env = argv.flatMap((a, i) => (a === "-e" ? [argv[i + 1]] : []));
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])
      expect(env).toContain(`${name}=http://127.0.0.1:41234`);
  });

  it("offers Marina's model API only with an allowlist, by placeholder, capped per command", () => {
    expect(() =>
      resolveContainerRunner({ image: IMAGE, modelApi: true }, {}, fakeWhich(["podman"])),
    ).toThrow("rides the egress proxy");
    const runner = resolveContainerRunner(
      { image: IMAGE, egress: parseEgressRules("pypi.org"), modelApi: true },
      {},
      fakeWhich(["podman"]),
    );
    expect(runner.modelApi).toEqual({ capUsd: 1 });
    const argv = containerRunArgv(runner, "/repo", ["true"], "n", { egressPort: 41234 });
    const env = argv.flatMap((a, i) => (a === "-e" ? [argv[i + 1]] : []));
    expect(env).toContain(`OPENAI_BASE_URL=http://${MARINA_MODEL_HOST}/v1`);
    expect(env).toContain("OPENAI_API_KEY=marina");
    expect(env).toContain(`ANTHROPIC_BASE_URL=http://${MARINA_MODEL_HOST}`);
    expect(env.some((v) => v?.includes("mrk_"))).toBe(false);
    expect(() =>
      resolveContainerRunner(
        { image: IMAGE, egress: parseEgressRules("pypi.org"), modelApi: true, modelCapUsd: -1 },
        {},
        fakeWhich(["podman"]),
      ),
    ).toThrow("non-negative");
  });

  it("refuses an allowlist on docker instead of pretending to enforce it", () => {
    expect(() =>
      resolveContainerRunner(
        { image: IMAGE, egress: parseEgressRules("registry.npmjs.org") },
        {},
        fakeWhich(["docker"]),
      ),
    ).toThrow("needs podman");
  });

  it("takes the allowlist from the operator only, never from a session setting", () => {
    const env = {
      MARINA_CODE_CONTAINER_IMAGE: IMAGE,
      MARINA_CODE_CONTAINER_EGRESS: "registry.npmjs.org,*.pypi.org",
      MARINA_CODE_CONTAINER_REQUIRED: "false",
    };
    expect(envRunnerConfig(env)?.egress).toHaveLength(2);
    // A session on the operator's image inherits the operator's list…
    const inherited = effectiveRunner(
      { kind: "container", config: { image: IMAGE, egress: parseEgressRules("evil.example") } },
      env,
    );
    expect(inherited.kind === "container" && inherited.config.egress?.map((r) => r.host)).toEqual([
      "registry.npmjs.org",
      "pypi.org",
    ]);
    // Model access is the operator's as well.
    const modelEnv = {
      ...env,
      MARINA_CODE_CONTAINER_MODEL_API: "on",
      MARINA_CODE_CONTAINER_MODEL_CAP_USD: "0.5",
    };
    expect(envRunnerConfig(modelEnv)).toMatchObject({ modelApi: true, modelCapUsd: 0.5 });
    const sessionTried = effectiveRunner(
      { kind: "container", config: { image: "docker.io/library/node:24", modelApi: true } },
      env,
    );
    expect(sessionTried.kind === "container" && sessionTried.config.modelApi).toBeUndefined();
    // …and a session on its own image cannot bring one.
    const own = effectiveRunner(
      {
        kind: "container",
        config: { image: "docker.io/library/node:24", egress: parseEgressRules("evil.example") },
      },
      env,
    );
    expect(own.kind === "container" && own.config.egress).toBeUndefined();
  });
});

describe("approved egress", () => {
  it("adds approved destinations only onto an operator allowlist", () => {
    const grants = parseEgressRules("files.example:443");
    const listed = { image: IMAGE, egress: parseEgressRules("registry.npmjs.org") };
    expect(withEgressGrants(listed, grants).egress?.map((r) => r.host)).toEqual([
      "registry.npmjs.org",
      "files.example",
    ]);
    // No operator list: a grant creates no network.
    expect(withEgressGrants({ image: IMAGE }, grants)).toEqual({ image: IMAGE });
    expect(withEgressGrants({ image: IMAGE, network: false }, grants).egress).toBeUndefined();
  });

  it("marks a destination approvable only if the address guard never refused it", () => {
    expect(
      distinctDenials([
        { host: "a.example", port: 443, reason: "unlisted", approvable: true },
        { host: "a.example", port: 443, reason: "unlisted", approvable: true },
        { host: "b.example", port: 443, reason: "unlisted", approvable: true },
        { host: "b.example", port: 443, reason: "private", approvable: false },
      ]),
    ).toEqual([
      { host: "a.example", port: 443, approvable: true },
      { host: "b.example", port: 443, approvable: false },
    ]);
  });
});
