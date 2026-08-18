// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional external-identity provider backed by better-auth.
 *
 * This module is loaded ONLY when `MARINA_AUTH=better-auth` (see main.ts), via a
 * dynamic import — mirroring the lazy adapter pattern in net/adapter-manager.ts.
 * When auth is disabled nothing here is imported, `better-auth` need not even be
 * installed, and standalone/local Marina is completely unaffected.
 *
 * better-auth supplies an ACCESS identity (email/password, social OAuth, later
 * enterprise SSO). It is deliberately NOT the in-world identity: the engine
 * bridges a verified identity to a *named* Marina entity (see engine.login's
 * `identity` path and net/auth-api.ts). The named entity remains the artilect.
 */

import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";

/** A verified external identity resolved from an incoming request. */
export interface IdentitySession {
  /** Stable better-auth user id — the binding key to a Marina entity. */
  subject: string;
  email: string;
  /** Display name from the identity provider (not the in-world handle). */
  displayName?: string;
  emailVerified: boolean;
}

/** The narrow surface the rest of Marina depends on (keeps better-auth types contained). */
export interface MarinaAuthProvider {
  /** Sign-in methods enabled, surfaced to the client login screen. */
  readonly methods: string[];
  /** Social provider ids enabled (e.g. ["google","github"]). */
  readonly socialProviders: string[];
  /** Handle a better-auth HTTP request (/api/auth/*). */
  handler(req: Request): Promise<Response>;
  /** Resolve the verified identity for a request, or null if unauthenticated. */
  getIdentity(headers: Headers): Promise<IdentitySession | null>;
}

/**
 * Canonical better-auth schema (email/password + social — social uses the
 * `account` table which is already present). Captured from better-auth 1.6.x
 * `compileMigrations()` and made idempotent with IF NOT EXISTS so we apply it
 * at startup without the (Bun-flaky) migrate CLI. Regenerate if a future phase
 * adds plugins with new tables (e.g. SSO).
 */
const SCHEMA_SQL = `
create table if not exists "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
create table if not exists "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
create table if not exists "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
create table if not exists "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
create index if not exists "session_userId_idx" on "session" ("userId");
create index if not exists "account_userId_idx" on "account" ("userId");
create index if not exists "verification_identifier_idx" on "verification" ("identifier");
`;

interface ProviderConfig {
  secret: string;
  baseURL: string;
  dbPath: string;
  social: Record<string, { clientId: string; clientSecret: string }>;
}

/** Read provider config from env; throws with a clear message if misconfigured. */
function readConfig(): ProviderConfig {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "MARINA_AUTH=better-auth requires BETTER_AUTH_SECRET (>= 32 chars). Generate one with `openssl rand -base64 32`.",
    );
  }
  const baseURL = process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.WS_PORT ?? 3300}`;
  const dbPath = process.env.BETTER_AUTH_DB_PATH ?? "marina-auth.db";

  const social: ProviderConfig["social"] = {};
  const SOCIAL_ENV: Record<string, [string, string]> = {
    google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    github: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
    microsoft: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
  };
  for (const [id, [idEnv, secretEnv]] of Object.entries(SOCIAL_ENV)) {
    const clientId = process.env[idEnv];
    const clientSecret = process.env[secretEnv];
    if (clientId && clientSecret) social[id] = { clientId, clientSecret };
  }

  return { secret, baseURL, dbPath, social };
}

/**
 * Construct the better-auth provider. Call only when auth is enabled.
 * Ensures the schema exists on the dedicated auth database (separate file from
 * Marina's main DB, so Marina's migrations stay untouched).
 */
export function createBetterAuthProvider(): MarinaAuthProvider {
  const cfg = readConfig();
  const db = new Database(cfg.dbPath);
  // Idempotent schema bootstrap (no CLI).
  db.exec(SCHEMA_SQL);

  const socialProviders = cfg.social;
  const auth = betterAuth({
    database: db,
    secret: cfg.secret,
    baseURL: cfg.baseURL,
    emailAndPassword: { enabled: true },
    ...(Object.keys(socialProviders).length > 0 ? { socialProviders } : {}),
  });

  const methods = ["email", ...Object.keys(socialProviders)];

  return {
    methods,
    socialProviders: Object.keys(socialProviders),
    handler: (req: Request) => auth.handler(req),
    async getIdentity(headers: Headers): Promise<IdentitySession | null> {
      const result = await auth.api.getSession({ headers });
      if (!result?.user) return null;
      return {
        subject: result.user.id,
        email: result.user.email,
        displayName: result.user.name ?? undefined,
        emailVerified: Boolean(result.user.emailVerified),
      };
    },
  };
}
