# Marina HTTP API: `marina.http.v1`

Marina's durable services are plain HTTPS with JSON bodies. This page is the guide. The contract
is the OpenAPI document.

- **OpenAPI 3.1:** [`marina.http.v1.openapi.json`](marina.http.v1.openapi.json). A running
  Marina world also serves it at `GET /api/openapi`. Point any OpenAPI code generator at it, or read it
  in any OpenAPI viewer.
- **What's in it:** 117 operations in four groups.

  | Group | Path | For |
  |---|---|---|
  | `memory` | `/v1/memory` | durable, versioned, cited memory: records, sources, checkpoints, transfers, assistance jobs |
  | `routing` | `/api/routing` | participant sessions: publish output, message other sessions, channels, supervised runtimes |
  | `investigations` | `/api/investigations` | a question run as a case: attempts, events, the chosen answer, a scored outcome |
  | `panels` | `/api/canvases` | published A2UI panels people and agents read and press |

- **Tested:** CI drives a live server through every operation with the TypeScript SDK and checks
  every request and every reply against the document. Five operations need a peer server or an
  embedding provider and are not driven; the test names them.

Live sessions (commands, coding runs, world events) are not HTTP: they use the WebSocket
protocol, [`marina.wire.v1`](README.md).

## Try it in a minute

Memory runs on its own, with a credential of its own. From a Marina checkout, make a database, a
credential and a private space, then start the server (port 3310 here, so it never collides with a
running world):

```bash
bun run memory init --db /tmp/try.db --name try --credentials /tmp/try.json
bun run memory serve --db /tmp/try.db --port 3310
```

`/tmp/try.json` holds `token` and `spaceId`. Write a record and search for it:

```bash
TOKEN=$(jq -r .token /tmp/try.json); SPACE=$(jq -r .spaceId /tmp/try.json)

curl -s http://127.0.0.1:3310/v1/memory/spaces/$SPACE/records \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: first-note" \
  -d '{"content": "Deploys run from main after CI passes"}'

curl -s http://127.0.0.1:3310/v1/memory/spaces/$SPACE/search \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query": "deploy"}'
```

The first reply is a receipt (`id`, `version`, `seq`). The second lists the matching records. Send the
first request again with the same `Idempotency-Key` and you get the same receipt back, with
nothing written twice.

A Marina world (`marina start`) serves the same memory API at `/v1/memory` next to the other
three groups, all on one port.

## Credentials

Every request carries `Authorization: Bearer <token>`. Which token depends on the group:

- **memory:** a memory credential. Audience `marina:memory`, scoped, expires after 30 days. Issue
  one with `bun run memory init` (above) and revoke it with `bun run memory revoke`. See the
  [memory service guide](../docs/guides/memory-service.md).
- **routing, investigations, panels:** your world session token. Log in over the
  [WebSocket](README.md#the-conversation) and keep the `token` from the session frame.
  Supervised runtimes can trade it for a routing-only supervision credential
  (`POST /api/routing/supervision`).

A token never goes in a URL, except for the live-changes socket below, which takes `?token=`.

## Rules that hold everywhere

- **Retry writes safely.** Every memory write takes an `Idempotency-Key` header (1-128
  characters). The same key replays the first result instead of writing again. A missing key is
  `400 idempotency_required`. POSTs that only read (`search`, `context`, `query`, `retrieve` and
  the others the document marks) need no key. Investigations take the key as `idempotencyKey`
  in the body. Routing messages carry your own `clientMessageId`.
- **Compare-and-set.** Revisions send the version they expect (`expected_version`,
  `expected_generation`, a panel's `revision`). A stale one is `409`. Read again and decide.
- **Pages.** Lists take a cursor (`after`, `cursor`) and a `limit`, and answer with the next one
  (`next_cursor`, `nextCursor`). Keep the cursor after you process each page.
- **Slow down when told.** `429` comes with `Retry-After` in seconds. Memory replies also give
  `retry_after_ms`, which is exact. Memory allows a burst of 100, then 25 a second per credential.
- **Ignore what you do not know.** Replies may gain fields within v1. A breaking change would be
  `marina.http.v2`.

## Errors

Branch on the `code`. The `message` / `error` text is for people and may change.

| Group | Error body |
|---|---|
| memory | `{"error": {"code": "…", "message": "…", "retry_after_ms": 1000}}` |
| routing, investigations | `{"error": "…", "code": "…"}` |
| panels | `{"error": "…"}`, with `code` on some failures |

## Live changes

Two things are pushed rather than polled:

- **Panels:** open `ws(s)://host/dashboard-ws?token=<session token>`. You get a `snapshot`
  frame, then `{"type": "event", "data": {…}}` for each change. Read the panel again over HTTP
  when one arrives. A reconnect starts with a fresh snapshot; missed events are not replayed.
- **Routing:** there is no push. Poll `GET …/sessions/{session}/events?after=<cursor>` every
  second or more, and keep `nextCursor`. `gap: true` means older events were pruned.

## Generate a client

Any generator that reads OpenAPI 3.1 can start from this file, for example:

```bash
# Python
openapi-python-client generate --path protocol/marina.http.v1.openapi.json
# Java, Rust, Go and others
openapi-generator-cli generate -i protocol/marina.http.v1.openapi.json -g rust -o marina-http
```

Marina's own SDKs (TypeScript today; Python, Java and Rust in progress) are written against this
document and the WebSocket schema, and tested against a live server the same way.
