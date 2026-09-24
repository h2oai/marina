// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { RateLimiter } from "../../auth/rate-limiter";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import { Logger } from "../logger";

/** Module logger. */
const logger = new Logger();

/**
 * Verification codes for linking external adapters (Telegram/Discord) to game accounts.
 * Codes are 6-character alphanumeric strings that expire after 5 minutes.
 */

interface PendingLink {
  code: string;
  userId: string;
  entityName: string;
  createdAt: number;
}

const LINK_NEEDS_DB =
  "This world is running without persistence, so account links wouldn't survive a restart. Restart with a database (DB_PATH) to enable linking.";
const LINK_NEEDS_USER =
  "No user record exists for this name yet. User records are created at login — log in through a normal session first, then retry.";

const CODE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (0/O, 1/I)

const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${CODE_CHARS}]{${CODE_LENGTH}}$`);

/** A code is a bearer credential for the link step, so it comes from the CSPRNG. */
function generateCode(): string {
  // 32 symbols divide 256 evenly, so `byte % 32` is unbiased.
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = "";
  for (const byte of bytes) code += CODE_CHARS[byte % CODE_CHARS.length];
  return code;
}

// Shared pending links map — accessible by adapters
const pendingLinks = new Map<string, PendingLink>();

/** Verify a code submitted by an external adapter. Returns user info or null. */
export function verifyLinkCode(code: string): { userId: string; entityName: string } | null {
  const upper = code.toUpperCase().trim();
  const pending = pendingLinks.get(upper);
  if (!pending) return null;

  if (Date.now() - pending.createdAt > CODE_EXPIRY_MS) {
    pendingLinks.delete(upper);
    return null;
  }

  pendingLinks.delete(upper);
  return { userId: pending.userId, entityName: pending.entityName };
}

// ─── Guessing limits ─────────────────────────────────────────────────────────
// A code is a 6-symbol bearer credential (32^6 ≈ 1.07e9) live for 5 minutes, and
// adapters are internet-facing even on a `local` box, so both buckets ignore
// `RateLimiter.bypass`. Only code-shaped messages are charged.

const LINK_ATTEMPTS_PER_ACCOUNT = { maxTokens: 5, refillRate: 1, refillInterval: 120_000 };
const LINK_FAILURES_GLOBAL = { maxTokens: 30, refillRate: 1, refillInterval: 10_000 };
const GLOBAL_KEY = "*";
/** Sweep idle per-account buckets this often so many throwaway accounts can't grow the map. */
const CLEANUP_EVERY_ATTEMPTS = 1000;
let attemptsSinceCleanup = 0;

let accountAttempts = new RateLimiter({ ...LINK_ATTEMPTS_PER_ACCOUNT, ignoreBypass: true });
let globalFailures = new RateLimiter({ ...LINK_FAILURES_GLOBAL, ignoreBypass: true });

/** Test seam: fresh buckets, optionally on an injected clock. */
export function resetLinkRateLimitsForTests(now?: () => number): void {
  attemptsSinceCleanup = 0;
  accountAttempts = new RateLimiter({ ...LINK_ATTEMPTS_PER_ACCOUNT, ignoreBypass: true, now });
  globalFailures = new RateLimiter({ ...LINK_FAILURES_GLOBAL, ignoreBypass: true, now });
}

/**
 * Adapter side of `link`: if `text` is a live code, bind the external account
 * (`adapter`, `externalId`) to the code's user and return the entity name to
 * log in as. Anything else returns null and the adapter treats the message as
 * usual. This only records the binding shown by `link status` — the login that
 * follows is an ordinary passwordless adapter login, so `engine.login` still
 * applies every gate (auth-required mode, bans, rank cap for remote logins).
 *
 * Guessing is rate-limited per external account and globally on failures. A
 * limited attempt is NOT checked and falls through as null — the same as any
 * non-code text — so a player whose login name happens to look like a code is
 * never locked out of name login.
 */
export function redeemLinkCode(
  db: Pick<MarinaDB, "linkAdapter"> | undefined,
  adapter: string,
  externalId: string,
  text: string,
): { entityName: string } | null {
  if (!db) return null;
  const candidate = text.trim().toUpperCase();
  if (!CODE_RE.test(candidate)) return null;
  const accountKey = `${adapter}:${externalId}`;
  if (++attemptsSinceCleanup >= CLEANUP_EVERY_ATTEMPTS) {
    attemptsSinceCleanup = 0;
    accountAttempts.cleanup();
  }
  if (!accountAttempts.consume(accountKey)) {
    logger.warn("link", "Link-code attempts rate-limited for an external account", {
      adapter,
      externalId,
    });
    return null;
  }
  if (globalFailures.getRemaining(GLOBAL_KEY) < 1) {
    logger.warn("link", "Link-code redemption paused: too many failed attempts", { adapter });
    return null;
  }
  const linked = verifyLinkCode(candidate);
  if (!linked) {
    globalFailures.consume(GLOBAL_KEY);
    return null;
  }
  accountAttempts.reset(accountKey);
  db.linkAdapter(adapter, externalId, linked.userId);
  return { entityName: linked.entityName };
}

export function linkCommand(deps: {
  getEntity: (id: EntityId) => Entity | undefined;
  db?: MarinaDB;
}): CommandDef {
  return {
    name: "link",
    aliases: [],
    help: "Link an external account (Telegram/Discord). Usage: link | link status | link unlink <adapter>",
    handler: (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const sub = input.tokens[0]?.toLowerCase();

      if (!sub || sub === "code") {
        // Generate a new link code
        if (!deps.db) {
          ctx.send(input.entity, LINK_NEEDS_DB);
          return;
        }

        const user = deps.db.getUserByName(entity.name);
        if (!user) {
          ctx.send(input.entity, LINK_NEEDS_USER);
          return;
        }

        // Clean expired codes for this user
        for (const [code, pending] of pendingLinks) {
          if (pending.userId === user.id && Date.now() - pending.createdAt > CODE_EXPIRY_MS) {
            pendingLinks.delete(code);
          }
        }

        const code = generateCode();
        pendingLinks.set(code, {
          code,
          userId: user.id,
          entityName: entity.name,
          createdAt: Date.now(),
        });

        const lines = [
          "\x1b[1;36mAccount Link Code\x1b[0m",
          "",
          `  Your code: \x1b[1;33m${code}\x1b[0m`,
          "",
          "  Send this code to the Marina bot on Telegram or Discord",
          "  to link your external account to your game identity.",
          "",
          "  The code expires in 5 minutes.",
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "status") {
        if (!deps.db) {
          ctx.send(input.entity, LINK_NEEDS_DB);
          return;
        }
        const user = deps.db.getUserByName(entity.name);
        if (!user) {
          ctx.send(input.entity, LINK_NEEDS_USER);
          return;
        }
        const links = deps.db.getUserLinks(user.id);
        if (links.length === 0) {
          ctx.send(input.entity, 'No linked accounts. Use "link" to generate a code.');
          return;
        }
        const lines = [
          "\x1b[1;36mLinked Accounts\x1b[0m",
          ...links.map((l) => `  \x1b[1m${l.adapter}\x1b[0m — ${l.external_id}`),
        ];
        ctx.send(input.entity, lines.join("\n"));
        return;
      }

      if (sub === "unlink") {
        const adapter = input.tokens[1]?.toLowerCase();
        if (!adapter) {
          ctx.send(input.entity, "Usage: link unlink <telegram|discord>");
          return;
        }
        if (!deps.db) {
          ctx.send(input.entity, LINK_NEEDS_DB);
          return;
        }
        const user = deps.db.getUserByName(entity.name);
        if (!user) {
          ctx.send(input.entity, LINK_NEEDS_USER);
          return;
        }
        const links = deps.db.getUserLinks(user.id);
        const link = links.find((l) => l.adapter === adapter);
        if (!link) {
          ctx.send(input.entity, `No ${adapter} account is linked.`);
          return;
        }
        deps.db.unlinkAdapter(adapter, link.external_id);
        ctx.send(input.entity, `Unlinked ${adapter} account.`);
        return;
      }

      ctx.send(input.entity, "Usage: link | link status | link unlink <adapter>");
    },
  };
}
