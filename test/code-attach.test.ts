// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AttachIO,
  chooseAttachSession,
  NO_TOKEN_MESSAGE,
  resolveAttach,
  resolveAttachName,
  resolveAttachUrl,
} from "../scripts/code-attach";
import { activeCodingSessions, openConnectedCodeSession } from "../scripts/code-connected";
import { parseDispatch } from "../scripts/marina";
import { listCachedParticipants, saveParticipantToken } from "../scripts/session-cache";
import { grant } from "../src/engine/safety-gates";
import { WebSocketServer } from "../src/net/websocket-server";
import type { MarinaAgent } from "../src/sdk/client";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

/** Scripted terminal: answers questions in order and records what was shown. */
function io(isTTY: boolean, answers: string[] = []) {
  const shown: string[] = [];
  const asked: string[] = [];
  const terminal: AttachIO = {
    isTTY,
    write: (text) => shown.push(text),
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? "";
    },
  };
  return { terminal, shown, asked };
}

const A = { name: "Ada", url: "ws://a.test:3300" };
const B = { name: "Bo", url: "ws://a.test:3300" };
const C = { name: "Cy", url: "wss://c.test" };

describe("marina attach dispatch", () => {
  it("parses url, name, session and tui in any order", () => {
    expect(parseDispatch(["attach"])).toEqual({ kind: "attach" });
    expect(
      parseDispatch(["attach", "--session", "s1", "ws://h:1", "--tui", "--name", "Ada"]),
    ).toEqual({ kind: "attach", url: "ws://h:1", name: "Ada", session: "s1", tui: true });
  });

  it("reports a bad attach argument in one line", () => {
    for (const argv of [
      ["attach", "--name"],
      ["attach", "--fresh"],
      ["attach", "ws://a", "ws://b"],
    ]) {
      const result = parseDispatch(argv);
      expect(result.kind).toBe("usage-error");
      const message = (result as { message?: string }).message!;
      expect(message).toContain("Usage: marina attach");
      expect(message).not.toContain("\n");
    }
  });

  it("names exactly what the flag form is missing and suggests attach", () => {
    const missing = (argv: string[], env: Record<string, string> = {}) =>
      (parseDispatch(argv, () => false, env) as { message?: string }).message;
    expect(missing(["--name", "Ada", "--session", "s"])).toBe(
      "Connected coding is missing --url <url> (or MARINA_URL). Or let Marina find them: marina attach [url] [--name <account>] [--session <id>] [--tui]",
    );
    expect(missing(["--url", "ws://h", "--session", "s"])).toStartWith(
      "Connected coding is missing --name <account>. ",
    );
    expect(missing(["--url", "ws://h", "--name", "Ada"])).toStartWith(
      "Connected coding is missing --session <id>. ",
    );
    expect(missing(["--session", "s"])).toStartWith(
      "Connected coding is missing --url <url> (or MARINA_URL) and --name <account>. ",
    );
    expect(missing(["--name", "Ada"], { MARINA_URL: "ws://h" })).toStartWith(
      "Connected coding is missing --session <id>. ",
    );
  });

  it("uses MARINA_URL as the default --url for connected coding", () => {
    expect(
      parseDispatch(["--name", "Ada", "--session", "s"], () => false, { MARINA_URL: "ws://h:9" }),
    ).toEqual({ kind: "code-connected", url: "ws://h:9", name: "Ada", session: "s" });
    // An explicit --url still wins.
    expect(
      parseDispatch(["--url", "ws://x", "--name", "Ada", "--session", "s"], () => false, {
        MARINA_URL: "ws://h:9",
      }),
    ).toMatchObject({ url: "ws://x" });
  });
});

describe("attach resolution order", () => {
  it("URL: argument, then MARINA_URL, then the only cached server", () => {
    expect(resolveAttachUrl("http://arg.test/ws", { MARINA_URL: "ws://env" }, [A])).toBe(
      "ws://arg.test",
    );
    expect(resolveAttachUrl(undefined, { MARINA_URL: "ws://env.test" }, [A])).toBe("ws://env.test");
    expect(resolveAttachUrl(undefined, {}, [A, B])).toBe("ws://a.test:3300");
    expect(() => resolveAttachUrl(undefined, {}, [])).toThrow(
      "No server URL. Pass one (marina attach [url]",
    );
    expect(() => resolveAttachUrl(undefined, {}, [A, C])).toThrow(
      "Cached identities belong to several servers (ws://a.test:3300, wss://c.test). Pass one: marina attach <url>.",
    );
  });

  it("name: --name, then the only cached identity for the URL", async () => {
    const t = io(false).terminal;
    expect(await resolveAttachName("Zed", "ws://a.test:3300", [A, B], t)).toBe("Zed");
    expect(await resolveAttachName(undefined, "wss://c.test", [A, B, C], t)).toBe("Cy");
    await expect(resolveAttachName("bad name", "wss://c.test", [C], t)).rejects.toThrow(
      "exact Marina account name",
    );
  });

  it("name: several identities use a numbered picker on a TTY", async () => {
    const t = io(true, ["2"]);
    expect(await resolveAttachName(undefined, "ws://a.test:3300", [A, B, C], t.terminal)).toBe(
      "Bo",
    );
    expect(t.shown).toEqual(["  1. Ada\n  2. Bo"]);
    expect(t.asked).toEqual(["Account on ws://a.test:3300 [1-2]: "]);
  });

  it("name: without a TTY several identities are an error that names them", async () => {
    const t = io(false);
    await expect(
      resolveAttachName(undefined, "ws://a.test:3300", [A, B], t.terminal),
    ).rejects.toThrow(
      "Several cached identities for ws://a.test:3300: Ada, Bo. Choose one with --name <account>.",
    );
    expect(t.asked).toEqual([]);
    expect(t.shown).toEqual([]);
  });

  it("name: an invalid pick is refused rather than guessed", async () => {
    await expect(
      resolveAttachName(undefined, "ws://a.test:3300", [A, B], io(true, ["9"]).terminal),
    ).rejects.toThrow("Several cached identities");
  });

  it("name: no cached identity asks on a TTY and is an error otherwise", async () => {
    expect(await resolveAttachName(undefined, "ws://n.test", [A], io(true, ["Neo"]).terminal)).toBe(
      "Neo",
    );
    await expect(
      resolveAttachName(undefined, "ws://n.test", [A], io(false).terminal),
    ).rejects.toThrow(
      "No cached identity for ws://n.test. Pass --name <account> after authenticating with: marina connect <account> --url ws://n.test",
    );
  });

  it("session: the only active session is chosen automatically", async () => {
    const t = io(false);
    expect(await chooseAttachSession([{ id: "s1", title: "one" }], A, t.terminal)).toBe("s1");
  });

  it("session: several use a numbered picker on a TTY and are an error otherwise", async () => {
    const sessions = [
      { id: "s1", title: "one" },
      { id: "s2", title: "" },
    ];
    const tty = io(true, ["1"]);
    expect(await chooseAttachSession(sessions, A, tty.terminal)).toBe("s1");
    expect(tty.shown).toEqual(["  1. s1  one\n  2. s2"]);
    const plain = io(false);
    await expect(chooseAttachSession(sessions, A, plain.terminal)).rejects.toThrow(
      "Several active coding sessions for Ada on ws://a.test:3300: s1, s2. Choose one with --session <id>.",
    );
    expect(plain.asked).toEqual([]);
  });

  it("session: none names the account, server and how to start one", async () => {
    await expect(chooseAttachSession([], A, io(true).terminal)).rejects.toThrow(
      "No active coding sessions for Ada on ws://a.test:3300. Start one there with: marina <folder>.",
    );
  });

  it("reads only active rows from a code list reply", () => {
    expect(
      activeCodingSessions([
        { kind: "message", timestamp: 0, data: {} },
        {
          kind: "message",
          timestamp: 0,
          data: {
            code: {
              event: "sessions_listed",
              rows: [
                { id: "a", status: "active", title: "A" },
                { id: "b", status: "completed", title: "B" },
              ],
            },
          },
        },
      ]),
    ).toEqual([{ id: "a", title: "A" }]);
  });
});

describe("attach credentials", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-attach-"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("lists cached identities without tokens and skips unusable entries", () => {
    saveParticipantToken("Ada", "http://a.test:3300/", "t1", directory);
    writeFileSync(join(directory, "Broken.json"), "{");
    writeFileSync(join(directory, "NoUrl.json"), JSON.stringify({ token: "x" }));
    writeFileSync(join(directory, "has-dash.json"), JSON.stringify({ token: "x", url: "ws://a" }));
    expect(listCachedParticipants(directory)).toEqual([{ name: "Ada", url: "ws://a.test:3300" }]);
    expect(listCachedParticipants(join(directory, "missing"))).toEqual([]);
  });

  it("resolves everything from the cache without prompting", async () => {
    saveParticipantToken("Ada", "ws://a.test:3300", "t1", directory);
    const t = io(false);
    const options = await resolveAttach(
      { tui: true },
      { env: {}, io: t.terminal, cacheDirectory: directory, login: async () => {} },
    );
    expect(options).toMatchObject({ url: "ws://a.test:3300", name: "Ada", tui: true });
    expect(options.token).toBeUndefined();
    expect(options.session).toBeUndefined();
    expect(typeof options.chooseSession).toBe("function");
  });

  it("without a credential: non-TTY keeps today's message, TTY logs in inline", async () => {
    await expect(
      resolveAttach(
        { url: "ws://a.test:3300", name: "Ada" },
        { env: {}, io: io(false).terminal, cacheDirectory: directory, login: async () => {} },
      ),
    ).rejects.toThrow(NO_TOKEN_MESSAGE);
    const logins: string[] = [];
    const tty = io(true);
    const options = await resolveAttach(
      { url: "ws://a.test:3300", name: "Ada", session: "s1" },
      {
        env: {},
        io: tty.terminal,
        cacheDirectory: directory,
        login: async (name, url) => {
          logins.push(`${name}@${url}`);
          saveParticipantToken(name, url, "fresh", directory);
        },
      },
    );
    expect(logins).toEqual(["Ada@ws://a.test:3300"]);
    expect(options).toMatchObject({ name: "Ada", session: "s1" });
  });

  it("a login that leaves no credential is refused, never a new identity", async () => {
    await expect(
      resolveAttach(
        { url: "ws://a.test:3300", name: "Ada" },
        { env: {}, io: io(true).terminal, cacheDirectory: directory, login: async () => {} },
      ),
    ).rejects.toThrow("The login did not leave a credential for Ada.");
  });

  it("MARINA_TOKEN stands in for a cached credential", async () => {
    const logins: string[] = [];
    const options = await resolveAttach(
      { url: "ws://a.test:3300", name: "Ada" },
      {
        env: { MARINA_TOKEN: "env-token" },
        io: io(true).terminal,
        cacheDirectory: directory,
        login: async (name) => {
          logins.push(name);
        },
      },
    );
    expect(logins).toEqual([]);
    expect(options.token).toBe("env-token");
  });
});

describe("attach against a running world", () => {
  let world: ReturnType<typeof createTestEngine>;
  let server: WebSocketServer;
  let state: DisposableStack;
  let cacheDirectory: string;
  let url: string;
  const clients: MarinaAgent[] = [];
  beforeEach(() => {
    world = createTestEngine({ storage: "disk" });
    const root = dirname(world.path);
    state = scopeProcessState({
      trustProfile: "shared",
      env: {
        MARINA_CODE_ROOTS: root,
        MARINA_CODE_DEFAULT_ROOT: root,
        MARINA_AUTONOMY: "guarded",
        MARINA_CHALLENGES: "off",
      },
    });
    const owner = world.login("Owner");
    grant(world.db, owner.entityId, "code.exec");
    const token = world.engine.sessionManager!.create(owner.entityId, "Owner", 0).token;
    world.engine.removeConnection(owner.connection.id);
    server = new WebSocketServer(world.engine, 0);
    server.start();
    url = `ws://127.0.0.1:${server.getPort()}`;
    cacheDirectory = join(root, "credentials");
    saveParticipantToken("Owner", url, token, cacheDirectory);
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    await server.stop();
    await world.dispose();
    state.dispose();
  });
  function session(id: string, createdBy = "Owner", status?: string) {
    world.db.createCodingSession({
      id,
      title: id,
      workspaceRoot: dirname(world.path),
      createdBy,
      ...(status ? { status } : {}),
    });
  }
  async function attach(terminal: AttachIO) {
    const options = await resolveAttach(
      {},
      { env: {}, io: terminal, cacheDirectory, login: async () => {} },
    );
    const connected = await openConnectedCodeSession(options);
    clients.push(connected.agent);
    return connected;
  }

  it("attaches to the identity's only active session with no flags", async () => {
    session("mine");
    session("finished", "Owner", "completed");
    session("theirs", "Someone");
    const connected = await attach(io(false).terminal);
    expect(connected.sessionId).toBe("mine");
    expect(connected.url).toBe(url);
  });

  it("refuses with no active session and reports the account and server", async () => {
    session("theirs", "Someone");
    await expect(attach(io(false).terminal)).rejects.toThrow(
      `No active coding sessions for Owner on ${url}. Start one there with: marina <folder>.`,
    );
  });

  it("picks among several on a TTY and refuses without one", async () => {
    session("first");
    session("second");
    await expect(attach(io(false).terminal)).rejects.toThrow(
      "Several active coding sessions for Owner",
    );
    const tty = io(true);
    // Sessions are listed newest first; pick by the label shown.
    tty.terminal.ask = async () => {
      const lines = tty.shown.at(-1)!.split("\n");
      return String(lines.findIndex((line) => line.includes("first")) + 1);
    };
    const connected = await attach(tty.terminal);
    expect(connected.sessionId).toBe("first");
  });
});
