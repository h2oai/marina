// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `marina attach [url] [--name N] [--session S] [--tui]` — connected coding without
 * assembling three flags by hand. Resolution only chooses among what the person already
 * has (a URL they set, a cached credential, an active session they own); it never creates
 * an identity or a session, and attaching still goes through `runConnectedCodeSession`.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ActiveCodingSession, ConnectedCodeOptions } from "./code-connected";
import {
  type CachedParticipant,
  cachedParticipantToken,
  cachedServerUrl,
  listCachedParticipants,
  participantUrl,
} from "./session-cache";

export const ATTACH_USAGE = "marina attach [url] [--name <account>] [--session <id>] [--tui]";

const ACCOUNT_NAME = /^[a-zA-Z0-9_]{1,20}$/;

/** Terminal interaction, injectable so resolution is testable without a TTY. */
export interface AttachIO {
  /** True only when both stdin and stdout are terminals the person is using. */
  isTTY: boolean;
  ask(question: string): Promise<string>;
  write(text: string): void;
}

export interface AttachOptions {
  url?: string;
  name?: string;
  session?: string;
  tui?: boolean;
}

/** URL: the argument, then MARINA_URL, then the URL of the only cached identity's server. */
export function resolveAttachUrl(
  arg: string | undefined,
  env: Record<string, string | undefined>,
  identities: CachedParticipant[],
): string {
  const explicit = arg ?? (env.MARINA_URL || undefined);
  if (explicit) return participantUrl(explicit);
  const urls = [...new Set(identities.map((identity) => identity.url))];
  if (urls.length === 1) return participantUrl(urls[0]!);
  if (urls.length === 0)
    throw new Error(
      `No server URL. Pass one (${ATTACH_USAGE}) or set MARINA_URL; no cached identity names a server.`,
    );
  throw new Error(
    `Cached identities belong to several servers (${urls.join(", ")}). Pass one: marina attach <url>.`,
  );
}

/**
 * Show a numbered list and read a choice. Returns undefined without a TTY (the caller
 * then reports what was found instead of guessing) or when the answer is not a number
 * on the list.
 */
export async function pickNumbered<T>(
  items: T[],
  label: (item: T) => string,
  prompt: string,
  io: AttachIO,
): Promise<T | undefined> {
  if (!io.isTTY) return undefined;
  io.write(items.map((item, i) => `  ${i + 1}. ${label(item)}`).join("\n"));
  const answer = (await io.ask(`${prompt} [1-${items.length}]: `)).trim();
  const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
  return items[index];
}

/**
 * Name: `--name`, then the only cached identity for this URL, then a numbered picker when
 * several (TTY only). With no cached identity a TTY may type the account name to log in.
 */
export async function resolveAttachName(
  flag: string | undefined,
  url: string,
  identities: CachedParticipant[],
  io: AttachIO,
): Promise<string> {
  if (flag !== undefined) {
    if (!ACCOUNT_NAME.test(flag))
      throw new Error("Use the exact Marina account name (1–20 letters, digits or underscores).");
    return flag;
  }
  const here = cachedServerUrl(url);
  const names = identities.filter((identity) => identity.url === here).map((i) => i.name);
  if (names.length === 1) return names[0]!;
  if (names.length > 1) {
    const picked = await pickNumbered(names, (name) => name, `Account on ${url}`, io);
    if (picked) return picked;
    throw new Error(
      `Several cached identities for ${url}: ${names.join(", ")}. Choose one with --name <account>.`,
    );
  }
  if (io.isTTY) {
    const typed = (await io.ask(`Account name on ${url}: `)).trim();
    if (ACCOUNT_NAME.test(typed)) return typed;
    throw new Error("Use the exact Marina account name (1–20 letters, digits or underscores).");
  }
  throw new Error(
    `No cached identity for ${url}. Pass --name <account> after authenticating with: marina connect <account> --url ${url}`,
  );
}

/** Session: `--session`, else the only active session, else a numbered picker (TTY only). */
export async function chooseAttachSession(
  sessions: ActiveCodingSession[],
  context: { name: string; url: string },
  io: AttachIO,
): Promise<string> {
  if (sessions.length === 0)
    throw new Error(
      `No active coding sessions for ${context.name} on ${context.url}. Start one there with: marina <folder>.`,
    );
  if (sessions.length === 1) return sessions[0]!.id;
  const label = (s: ActiveCodingSession) => (s.title ? `${s.id}  ${s.title}` : s.id);
  const picked = await pickNumbered(sessions, label, "Coding session", io);
  if (picked) return picked.id;
  throw new Error(
    `Several active coding sessions for ${context.name} on ${context.url}: ${sessions
      .map((s) => s.id)
      .join(", ")}. Choose one with --session <id>.`,
  );
}

export const NO_TOKEN_MESSAGE =
  "Authenticate with marina connect <name> on this server first, or set MARINA_TOKEN. Connected coding never falls back to a new identity.";

/** The existing `marina connect <name>` login, run as its own process; output stays on stderr. */
export async function loginWithConnect(name: string, url: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [join(import.meta.dir, "connect.ts"), name, "--url", url, "-c", "look", "--wait", "0"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`Logging in as ${name} on ${url} failed.`);
}

export interface AttachDeps {
  env: Record<string, string | undefined>;
  io: AttachIO;
  cacheDirectory?: string;
  login: (name: string, url: string) => Promise<void>;
}

/**
 * Resolve URL, name and credential, then hand back the options for
 * `runConnectedCodeSession`; the session is chosen after authentication on that connection.
 */
export async function resolveAttach(
  options: AttachOptions,
  deps: AttachDeps,
): Promise<ConnectedCodeOptions> {
  const identities = listCachedParticipants(deps.cacheDirectory);
  const url = resolveAttachUrl(options.url, deps.env, identities);
  const name = await resolveAttachName(options.name, url, identities, deps.io);
  const token = deps.env.MARINA_TOKEN || undefined;
  if (!token && !cachedParticipantToken(name, url, deps.cacheDirectory)) {
    if (!deps.io.isTTY) throw new Error(NO_TOKEN_MESSAGE);
    deps.io.write(`No cached credential for ${name} on ${url}. Logging in with marina connect.`);
    await deps.login(name, url);
    if (!cachedParticipantToken(name, url, deps.cacheDirectory))
      throw new Error(`The login did not leave a credential for ${name}. ${NO_TOKEN_MESSAGE}`);
  }
  return {
    url,
    name,
    ...(options.session !== undefined ? { session: options.session } : {}),
    ...(token ? { token } : {}),
    ...(deps.cacheDirectory ? { cacheDirectory: deps.cacheDirectory } : {}),
    ...(options.tui ? { tui: true } : {}),
    chooseSession: (sessions) => chooseAttachSession(sessions, { name, url }, deps.io),
  };
}

/** Prompts go to stderr so stdout stays the session's own output. */
export function terminalAttachIO(): AttachIO {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    write: (text) => process.stderr.write(`${text}\n`),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await new Promise<string>((resolve) => {
          rl.once("close", () => resolve(""));
          rl.question(question, resolve);
        });
      } finally {
        rl.close();
      }
    },
  };
}
