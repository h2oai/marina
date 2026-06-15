# Authentication (optional, for public hosting)

Marina ships **open by default**: a local or standalone instance needs no auth — you
connect, pick a name, and you're in. That's ideal for development and single-operator use.

For **public / multi-user hosting**, Marina offers an *optional* authentication layer built on
[better-auth](https://github.com/better-auth/better-auth) (self-hosted, OIDC/SAML-capable). It is
**off unless you turn it on**, and when off it is never imported and changes nothing.

> **Default (no setup):** passwordless name-login over WebSocket/telnet, and admins set by name via
> `MARINA_ADMINS`. Fine locally; **not** safe on a public port (anyone could claim the admin name).
> Turning auth on closes both holes.

## What turning it on changes

- The webchat/dashboard requires **sign-in** (email/password, plus any social providers you configure).
- The unsafe **passwordless name-login is rejected** for external clients.
- A signed-in human is **bridged to a *named* Marina entity** (the "artilect"). The better-auth account
  (email/OAuth) is only an *access credential* — the in-world identity stays the named entity you claim.
- **Admins are granted by verified email** (`MARINA_AUTH_ADMIN_EMAILS`), never by name.
- **Agents are unaffected.** Coding agents / SDK / MCP clients keep authenticating with **session
  tokens**, and internal room/crew agents with the internal token. They never need a human login.

## Identity model

```
better-auth account (email / OAuth)  ──bind──▶  Marina users row (name, rank)  ──▶  named entity "creator"
   = ACCESS identity (cookie/session)              auth_subject = account id          = IN-WORLD identity
```

On first sign-in you **claim a handle** (e.g. `creator`); it's bound to your account and reused on every
future sign-in. The handle — not your email — is who you are inside the world.

## Prerequisites

The `better-auth` package is an **optional dependency**. A normal `bun install` includes it; a
production install that skips optional deps must include it when auth is enabled:

```bash
bun install              # includes optional deps (better-auth, jose)
# or, if you installed with --production --omit=optional:
bun add better-auth jose
```

## Local setup — email/password (quickstart)

```bash
# .env
MARINA_AUTH=better-auth
BETTER_AUTH_SECRET=<32+ random chars>     # openssl rand -base64 32
BETTER_AUTH_URL=http://localhost:3300     # this instance's base URL
# BETTER_AUTH_DB_PATH=marina-auth.db      # optional; defaults to marina-auth.db
# MARINA_AUTH_ADMIN_EMAILS=you@company.com
```

```bash
bun run start
# → log line: "External auth enabled (better-auth) — sign-in required; methods: email"
```

Open the dashboard (`http://localhost:3300/dashboard`). You'll see a **Sign in / Create account**
screen; after sign-up you **claim a handle**, and you're in. The auth tables live in their own SQLite
file (`BETTER_AUTH_DB_PATH`), separate from Marina's main DB; they're created automatically on first boot.

Verify from the CLI:

```bash
curl -s localhost:3300/api/auth-status
# {"required":true,"methods":["email"],"socialProviders":[]}
```

## Social OAuth (Google / GitHub / Microsoft)

Set both the id and secret for each provider you want; the button appears automatically.

```bash
GOOGLE_CLIENT_ID=...        GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...        GITHUB_CLIENT_SECRET=...
MICROSOFT_CLIENT_ID=...     MICROSOFT_CLIENT_SECRET=...
```

In each provider's console, register the **redirect/callback URL**:

```
<BETTER_AUTH_URL>/api/auth/callback/<provider>
# e.g. https://marina.example.com/api/auth/callback/google
```

Social providers return **verified** emails, so `MARINA_AUTH_ADMIN_EMAILS` works out of the box —
this is the recommended way to grant admins.

## Admins

```bash
MARINA_AUTH_ADMIN_EMAILS=you@company.com,ops@company.com
```

A matching **verified** email is promoted to rank 9 (sovereign) + all safety gates on sign-in. With
auth on, name-based `MARINA_ADMINS` is ignored.

> **Note:** plain email/password sign-ups are *unverified* unless you wire an email-verification mailer,
> so they won't receive admin. For admins, use a social/SSO provider (verified email), or enable
> better-auth email verification. Non-admin users work fine unverified.

## How agents authenticate when auth is on

Agents do **not** sign in. They present a **session token** (the same `{type:"auth", token}` WebSocket
flow / `MarinaClient.reconnect(token)` the SDK already uses), and internal room/crew agents use the
auto-generated internal token. Provision a long-lived token for an external coding agent the same way a
human session token is issued, then point the agent at it. Only *human passwordless name-login* is gated.

## Endpoints (reference)

| Route | Purpose |
|-------|---------|
| `GET /api/auth-status` | `{required, methods, socialProviders}` — the dashboard uses this to decide whether to show sign-in. Returns `required:false` when auth is off. |
| `/api/auth/*` | better-auth's own endpoints (sign-up/in/out, social callbacks). |
| `POST /api/auth-session` | Bridge: exchanges a verified better-auth session for a Marina session token bound to a claimed handle. |

## Troubleshooting

- **"This instance requires sign-in" on connect** — expected when auth is on and no valid token is
  presented. Sign in via the dashboard (humans) or present a session token (agents).
- **OAuth redirect error / `redirect_uri_mismatch`** — the callback URL in the provider console must
  exactly match `<BETTER_AUTH_URL>/api/auth/callback/<provider>`, and `BETTER_AUTH_URL` must be your real
  public URL.
- **Refusing to start: "Failed to initialize better-auth"** — usually a missing/short
  `BETTER_AUTH_SECRET` (needs ≥ 32 chars) or `better-auth` not installed.
- **Admin not granted** — the email must be in `MARINA_AUTH_ADMIN_EMAILS` **and** verified (use OAuth, or
  enable email verification).
- **Going back to open/local mode** — unset `MARINA_AUTH`. For local dev that still wants the dashboard
  admin APIs without a login, `MARINA_OPEN_API=true` bypasses the gate (development only).

## API keys at rest

Provider API keys added through the **Admin → Keys** panel (or the `key` command) are stored
**in plaintext** in the SQLite database (`api_keys` table). Authentication gates *who can reach*
the panel; it does **not** encrypt what's stored.

- **Prefer env vars.** Set provider keys via environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  …, `LLAMA_API_KEY`). They're read live, take precedence on the `marina/default` proxy path, and
  are **never written to the database** — so a DB/volume leak doesn't expose them.
- **If you store keys in the DB**, keep the data volume on encrypted storage and restrict file
  permissions. **Admin → Security** shows whether key-at-rest encryption is active.

## Notes / current scope

- Implemented: email/password + social OAuth, identity→named-entity bridge, admin-by-verified-email.
- **Not yet implemented: API-key encryption at rest** — DB-stored keys are plaintext (see above).
- Enforcement currently targets the **web surfaces** (webchat/dashboard + HTTP). Telnet/MCP remain
  token-or-open in public mode; gate them at the network layer if exposed.
- Roadmap: enterprise SSO (OIDC/SAML via better-auth's SSO plugin), a dashboard sign-out control, and an
  admin UX for issuing agent tokens.
