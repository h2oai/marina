# HTTP dispatch reference

Generated from the TypeScript syntax tree of every network adapter by `bun run docs:api`.

This indexes exact route selectors and method tests, including regex captures and delegated
prefixes. Guards are source predicates: a negative guard can reject a method. Prefix selectors
can delegate to another adapter; they are not promises that every suffix is served. `rest`
in the memory adapter is the suffix after `/v1/memory/spaces/{space_id}/`. Captures and dynamic
subroutes retain their source spelling rather than inventing parameter names or response schemas.

Typed public client request/response contracts are in the [SDK reference](sdk.md). The
[security architecture](../architecture/security.md) explains authentication: world dashboard
routes require resident/session authority with operator-only restrictions; durable memory uses
scoped credentials and space ACLs; the model API uses its configured keys. Public health/connect
routes do not grant authority. A listed route never bypasses its handler's permission checks.

Field lists are syntax-derived accesses, not declarations of required fields. Follow the source
link for validation, HTTP statuses, streaming and deployment-specific availability.

## src/net/asset-api.ts

### `url.pathname.match(/^\/api\/assets\/(.+)$/)`

[Source](../../src/net/asset-api.ts#L232)

- Guard: `idMatch && method === "DELETE"`
- Guard: `method === "DELETE"`

### `url.pathname === "/api/assets"`

[Source](../../src/net/asset-api.ts#L260)

- Guard: `url.pathname === "/api/assets" && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname === "/api/assets"`

[Source](../../src/net/asset-api.ts#L265)

- Guard: `url.pathname === "/api/assets" && method === "GET"`
- Guard: `method === "GET"`

Fields read here: `Math.min(Number(url.searchParams.get("limit")) &#124;&#124; 50, 200)`, `Number(url.searchParams.get("limit"))`, `url.searchParams.get("limit")`, `url.searchParams.get("mime")`.

## src/net/auth-api.ts

### `url.pathname === "/api/auth-status"`

[Source](../../src/net/auth-api.ts#L87)

- Guard: `url.pathname === "/api/auth-status" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname.startsWith("/api/auth/")`

[Source](../../src/net/auth-api.ts#L103)

- Guard: `url.pathname.startsWith("/api/auth/")`

### `url.pathname === "/api/auth-session"`

[Source](../../src/net/auth-api.ts#L108)

- Guard: `url.pathname === "/api/auth-session" && method === "POST"`
- Guard: `method === "POST"`

## src/net/canvas-api.ts

### `url.pathname.match( /^\/api\/canvases\/([^/]+)\/nodes\/([^/]+)\/intent\/(claim&#124;complete&#124;fail)$/, )`

[Source](../../src/net/canvas-api.ts#L171)

- Guard: `intentActionMatch && method === "POST"`
- Guard: `method === "POST"`

Fields read here: `data`, `reason`, `result`, `type`.

### `url.pathname.match(/^\/api\/canvases\/([^/]+)\/edges(?:\/([^/]+))?$/)`

[Source](../../src/net/canvas-api.ts#L178)

- Guard: `edgeMatch`
- Guard: `method === "POST"`
- Guard: `method === "DELETE"`

Fields read here: `data`, `relationship`, `sourceId`, `targetId`.

### `url.pathname.match(/^\/api\/canvases\/([^/]+)\/nodes\/([^/]+)$/)`

[Source](../../src/net/canvas-api.ts#L354)

- Guard: `nodeMatch`
- Guard: `method === "DELETE"`
- Guard: `method === "PATCH"`
- Guard: `method === "GET"`

Fields read here: `data`, `height`, `width`, `x`, `y`.

### `url.pathname.match(/^\/api\/canvases\/([^/]+)\/nodes$/)`

[Source](../../src/net/canvas-api.ts#L435)

- Guard: `nodesMatch && method === "POST"`
- Guard: `method === "POST"`

Fields read here: `asset_id`, `data`, `height`, `parent_node_id`, `type`, `width`, `x`, `y`.

### `url.pathname.match(/^\/api\/canvases\/([^/]+)$/)`

[Source](../../src/net/canvas-api.ts#L505)

- Guard: `canvasMatch`
- Guard: `method === "DELETE"`
- Guard: `method === "GET"`

### `url.pathname === "/api/canvases"`

[Source](../../src/net/canvas-api.ts#L540)

- Guard: `url.pathname === "/api/canvases" && method === "POST"`
- Guard: `method === "POST"`

Fields read here: `description`, `name`, `scope`, `scope_id`.

### `url.pathname === "/api/canvases"`

[Source](../../src/net/canvas-api.ts#L587)

- Guard: `url.pathname === "/api/canvases" && method === "GET"`
- Guard: `method === "GET"`

Fields read here: `Math.min(Number(url.searchParams.get("limit")) &#124;&#124; 50, 200)`, `Number(url.searchParams.get("limit"))`, `url.searchParams.get("limit")`, `url.searchParams.get("scope")`.

## src/net/connect-api.ts

### `url.pathname === "/api/connect"`

[Source](../../src/net/connect-api.ts#L195)

- Guard: `url.pathname === "/api/connect"`

### `url.pathname === "/api/connect/negotiate"`

[Source](../../src/net/connect-api.ts#L196)

- Guard: `url.pathname === "/api/connect/negotiate"`

### `url.pathname === "/api/skill"`

[Source](../../src/net/connect-api.ts#L197)

- Guard: `url.pathname === "/api/skill"`

## src/net/dashboard-api.ts

### `url.pathname === "/api/traces"`

[Source](../../src/net/dashboard-api.ts#L102)

- Guard: `(url.pathname === "/api/traces" &#124;&#124; url.pathname === "/api/logs" &#124;&#124; url.pathname.startsWith("/api/evidence/")) && !memory.privilegedRead`

### `url.pathname === "/api/logs"`

[Source](../../src/net/dashboard-api.ts#L103)

- Guard: `(url.pathname === "/api/traces" &#124;&#124; url.pathname === "/api/logs" &#124;&#124; url.pathname.startsWith("/api/evidence/")) && !memory.privilegedRead`

### `url.pathname.startsWith("/api/evidence/")`

[Source](../../src/net/dashboard-api.ts#L104)

- Guard: `(url.pathname === "/api/traces" &#124;&#124; url.pathname === "/api/logs" &#124;&#124; url.pathname.startsWith("/api/evidence/")) && !memory.privilegedRead`

### `url.pathname === "/api/extensions/widgets"`

[Source](../../src/net/dashboard-api.ts#L109)

- Guard: `url.pathname === "/api/extensions/widgets" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname.startsWith("/api/")`

[Source](../../src/net/dashboard-api.ts#L137)

- Guard: `url.pathname === "/api/extensions/widgets" && method === "GET"`

## src/net/dashboard-api/agents.ts

### `url.pathname === "/api/agents"`

[Source](../../src/net/dashboard-api/agents.ts#L112)

- Guard: `url.pathname === "/api/agents" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/agents/spawn"`

[Source](../../src/net/dashboard-api/agents.ts#L115)

- Guard: `url.pathname === "/api/agents/spawn" && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname.match(/^\/api\/agents\/([^/]+)$/)`

[Source](../../src/net/dashboard-api/agents.ts#L120)

- Guard: `agentMatch`
- Guard: `method === "GET"`

### `url.pathname.match(/^\/api\/agents\/([^/]+)\/stop$/)`

[Source](../../src/net/dashboard-api/agents.ts#L129)

- Guard: `agentStopMatch && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname.match(/^\/api\/agents\/([^/]+)\/attention$/)`

[Source](../../src/net/dashboard-api/agents.ts#L136)

- Guard: `agentAttentionMatch && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname.match(/^\/api\/agents\/([^/]+)\/config$/)`

[Source](../../src/net/dashboard-api/agents.ts#L143)

- Guard: `agentConfigMatch && method === "POST"`
- Guard: `method === "POST"`

## src/net/dashboard-api/command.ts

### `url.pathname === "/api/setup-status"`

[Source](../../src/net/dashboard-api/command.ts#L167)

- Guard: `url.pathname === "/api/setup-status" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/ui-config"`

[Source](../../src/net/dashboard-api/command.ts#L183)

- Guard: `url.pathname === "/api/ui-config" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/command"`

[Source](../../src/net/dashboard-api/command.ts#L191)

- Guard: `url.pathname === "/api/command" && method === "POST"`
- Guard: `method === "POST"`

Fields read here: `command`, `error`.

### `url.pathname === "/api/ask"`

[Source](../../src/net/dashboard-api/command.ts#L203)

- Guard: `url.pathname === "/api/ask" && method === "POST"`
- Guard: `method === "POST"`

Fields read here: `error`, `query`.

### `url.pathname === "/api/federation/manifest"`

[Source](../../src/net/dashboard-api/command.ts#L215)

- Guard: `url.pathname === "/api/federation/manifest" && method === "GET" && db`
- Guard: `method === "GET"`

## src/net/dashboard-api/discovery.ts

### `url.pathname === "/api/command-catalog"`

[Source](../../src/net/dashboard-api/discovery.ts#L16)

- Guard: `url.pathname === "/api/command-catalog"`
- Guard: `method !== "GET"`

### `url.pathname.match(/^\/api\/entities\/([^/]+)\/quests$/)`

[Source](../../src/net/dashboard-api/discovery.ts#L25)

- Guard: `questMatch`
- Guard: `method !== "GET"`

### `url.pathname.match(/^\/api\/entities\/([^/]+)\/preview$/)`

[Source](../../src/net/dashboard-api/discovery.ts#L26)

- Guard: `previewMatch`
- Guard: `method !== "GET"`

## src/net/dashboard-api/keys.ts

### `url.pathname === "/api/keys"`

[Source](../../src/net/dashboard-api/keys.ts#L550)

- Guard: `url.pathname === "/api/keys" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/keys"`

[Source](../../src/net/dashboard-api/keys.ts#L560)

- Guard: `url.pathname === "/api/keys" && method === "POST" && db`
- Guard: `method === "POST"`

### `url.pathname.match(/^\/api\/keys\/([^/]+)$/)`

[Source](../../src/net/dashboard-api/keys.ts#L563)

- Guard: `keyDeleteMatch && method === "DELETE" && db`
- Guard: `method === "DELETE"`

### `url.pathname.match(/^\/api\/keys\/([^/]+)\/test$/)`

[Source](../../src/net/dashboard-api/keys.ts#L573)

- Guard: `keyTestMatch && method === "POST" && db`
- Guard: `method === "POST"`

### `url.pathname === "/api/default-model"`

[Source](../../src/net/dashboard-api/keys.ts#L587)

- Guard: `url.pathname === "/api/default-model" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/default-model"`

[Source](../../src/net/dashboard-api/keys.ts#L593)

- Guard: `url.pathname === "/api/default-model" && method === "PUT" && db`
- Guard: `method === "PUT"`

Fields read here: `error`, `model`.

### `url.pathname === "/api/default-model"`

[Source](../../src/net/dashboard-api/keys.ts#L609)

- Guard: `url.pathname === "/api/default-model" && method === "DELETE" && db`
- Guard: `method === "DELETE"`

### `url.pathname === "/api/model-endpoint"`

[Source](../../src/net/dashboard-api/keys.ts#L618)

- Guard: `url.pathname === "/api/model-endpoint" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/model-endpoint"`

[Source](../../src/net/dashboard-api/keys.ts#L621)

- Guard: `url.pathname === "/api/model-endpoint" && method === "PUT" && db`
- Guard: `method === "PUT"`

Fields read here: `error`.

### `url.pathname === "/api/models"`

[Source](../../src/net/dashboard-api/keys.ts#L632)

- Guard: `url.pathname === "/api/models" && method === "GET"`
- Guard: `method === "GET"`

Fields read here: `url.searchParams.get("refresh")`.

### `url.pathname === "/api/adapters"`

[Source](../../src/net/dashboard-api/keys.ts#L639)

- Guard: `url.pathname === "/api/adapters" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/adapters"`

[Source](../../src/net/dashboard-api/keys.ts#L642)

- Guard: `url.pathname === "/api/adapters" && method === "POST" && db`
- Guard: `method === "POST"`

### `url.pathname.match(/^\/api\/adapters\/([^/]+)$/)`

[Source](../../src/net/dashboard-api/keys.ts#L648)

- Guard: `adapterMatch && method === "PATCH" && db`
- Guard: `method === "PATCH"`

### `url.pathname === "/api/roles"`

[Source](../../src/net/dashboard-api/keys.ts#L663)

- Guard: `url.pathname === "/api/roles" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/traits"`

[Source](../../src/net/dashboard-api/keys.ts#L666)

- Guard: `url.pathname === "/api/traits" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/mcp"`

[Source](../../src/net/dashboard-api/keys.ts#L671)

- Guard: `url.pathname === "/api/mcp" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/env"`

[Source](../../src/net/dashboard-api/keys.ts#L680)

- Guard: `url.pathname === "/api/env" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/env"`

[Source](../../src/net/dashboard-api/keys.ts#L683)

- Guard: `url.pathname === "/api/env" && method === "PUT"`
- Guard: `method === "PUT"`

## src/net/dashboard-api/memory.ts

### `url.pathname === "/api/memory/overview"`

[Source](../../src/net/dashboard-api/memory.ts#L39)

- Guard: `url.pathname === "/api/memory/overview" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/memory/hygiene"`

[Source](../../src/net/dashboard-api/memory.ts#L44)

- Guard: `url.pathname === "/api/memory/hygiene" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/memory/hygiene/history"`

[Source](../../src/net/dashboard-api/memory.ts#L50)

- Guard: `url.pathname === "/api/memory/hygiene/history" && method === "GET" && db`
- Guard: `method === "GET"`

Fields read here: `Number.parseInt(url.searchParams.get("hours") ?? "", 10)`, `url.searchParams.get("hours")`.

### `url.pathname === "/api/memory/hygiene/snapshot"`

[Source](../../src/net/dashboard-api/memory.ts#L56)

- Guard: `url.pathname === "/api/memory/hygiene/snapshot" && method === "POST" && db`
- Guard: `method === "POST"`

### `url.pathname === "/api/memory/jobs"`

[Source](../../src/net/dashboard-api/memory.ts#L64)

- Guard: `url.pathname === "/api/memory/jobs" && method === "GET" && db`
- Guard: `method === "GET"`

Fields read here: `Number.parseInt(url.searchParams.get("limit") ?? "", 10)`, `json( listMemoryJobs(db, memoryObserverScope(engine, callerId), { state: stateParam === "all" ? "all" : "open", role: url.searchParams.get("role") ?? undefined, entity: url.searchParams.get("entity") ?? undefined, limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50, cursor: url.searchParams.get("cursor"), }), )`, `listMemoryJobs(db, memoryObserverScope(engine, callerId), { state: stateParam === "all" ? "all" : "open", role: url.searchParams.get("role") ?? undefined, entity: url.searchParams.get("entity") ?? undefined, limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50, cursor: url.searchParams.get("cursor"), })`, `url.searchParams.get("cursor")`, `url.searchParams.get("entity")`, `url.searchParams.get("limit")`, `url.searchParams.get("role")`, `url.searchParams.get("state")`.

### `url.pathname.match(/^\/api\/memory\/jobs\/([^/]+)(\/cancel)?$/)`

[Source](../../src/net/dashboard-api/memory.ts#L81)

- Guard: `memoryJobMatch && db`
- Guard: `method === "GET"`
- Guard: `method === "POST"`

### `url.pathname === "/api/memory/graph"`

[Source](../../src/net/dashboard-api/memory.ts#L97)

- Guard: `url.pathname === "/api/memory/graph" && method === "GET" && db`
- Guard: `method === "GET"`

Fields read here: `Number.parseInt(url.searchParams.get("limit") ?? "", 10)`, `buildMemoryGraph(engine, memoryObserverScope(engine, callerId), { entity: url.searchParams.get("entity") ?? undefined, limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 400, })`, `json( buildMemoryGraph(engine, memoryObserverScope(engine, callerId), { entity: url.searchParams.get("entity") ?? undefined, limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 400, }), )`, `url.searchParams.get("entity")`, `url.searchParams.get("limit")`.

### `url.pathname === "/api/memory/quality"`

[Source](../../src/net/dashboard-api/memory.ts#L107)

- Guard: `url.pathname === "/api/memory/quality" && method === "GET" && db`
- Guard: `method === "GET"`

Fields read here: `url.searchParams.get("entity")`.

### `url.pathname === "/api/memory/contradictions"`

[Source](../../src/net/dashboard-api/memory.ts#L113)

- Guard: `url.pathname === "/api/memory/contradictions" && method === "GET" && db`
- Guard: `method === "GET"`

Fields read here: `url.searchParams.get("status")`.

### `url.pathname.match( /^\/api\/memory\/contradictions\/(\d+)\/resolve$/, )`

[Source](../../src/net/dashboard-api/memory.ts#L131)

- Guard: `contradictionResolveMatch && method === "POST" && db`
- Guard: `method === "POST"`

Fields read here: `rationale`.

### `url.pathname === "/api/graph"`

[Source](../../src/net/dashboard-api/memory.ts#L174)

- Guard: `url.pathname === "/api/graph" && method === "GET" && db`
- Guard: `method === "GET"`

Fields read here: `Number.parseInt(url.searchParams.get("limit") ?? "", 10)`, `url.searchParams.get("limit")`.

### `url.pathname.match(/^\/api\/memory\/graph\/([^/]+)$/)`

[Source](../../src/net/dashboard-api/memory.ts#L203)

- Guard: `graphMatch && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname.match(/^\/api\/memory\/notes\/(.+)$/)`

[Source](../../src/net/dashboard-api/memory.ts#L242)

- Guard: `memNotesMatch && db`

### `url.pathname.match(/^\/api\/notes\/(\d+)$/)`

[Source](../../src/net/dashboard-api/memory.ts#L251)

- Guard: `noteDetailMatch && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname.match(/^\/api\/memory\/core\/(.+)$/)`

[Source](../../src/net/dashboard-api/memory.ts#L299)

- Guard: `memCoreMatch && db`

### `url.pathname === "/api/memory/pools"`

[Source](../../src/net/dashboard-api/memory.ts#L307)

- Guard: `url.pathname === "/api/memory/pools" && db`

## src/net/dashboard-api/ops.ts

### `url.pathname === "/api/ops/overview"`

[Source](../../src/net/dashboard-api/ops.ts#L31)

- Guard: `url.pathname === "/api/ops/overview" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname.match(/^\/api\/ops\/agents\/([^/]+)\/stop$/)`

[Source](../../src/net/dashboard-api/ops.ts#L34)

- Guard: `opsAgentStopMatch && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname === "/api/ops/decisions/settings"`

[Source](../../src/net/dashboard-api/ops.ts#L50)

- Guard: `url.pathname === "/api/ops/decisions/settings" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/ops/decisions/settings"`

[Source](../../src/net/dashboard-api/ops.ts#L60)

- Guard: `url.pathname === "/api/ops/decisions/settings" && method === "PUT"`
- Guard: `method === "PUT"`

Fields read here: `error`, `setting`, `value`.

## src/net/dashboard-api/readiness.ts

### `url.pathname === "/api/readiness"`

[Source](../../src/net/dashboard-api/readiness.ts#L19)

- Guard: `url.pathname === "/api/readiness" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/operations/alerts"`

[Source](../../src/net/dashboard-api/readiness.ts#L22)

- Guard: `url.pathname === "/api/operations/alerts" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname.match(/^\/api\/operations\/alerts\/(\d+)\/(ack&#124;resolve)$/)`

[Source](../../src/net/dashboard-api/readiness.ts#L32)

- Guard: `opsAlertMatch && method === "POST" && db`
- Guard: `method === "POST"`

### `url.pathname.match(/^\/api\/operations\/alerts\/(\d+)\/snooze$/)`

[Source](../../src/net/dashboard-api/readiness.ts#L42)

- Guard: `opsAlertSnoozeMatch && method === "POST" && db`
- Guard: `method === "POST"`

Fields read here: `durationMs`, `error`.

### `url.pathname === "/api/productivity"`

[Source](../../src/net/dashboard-api/readiness.ts#L64)

- Guard: `url.pathname === "/api/productivity" && method === "GET" && db`
- Guard: `method === "GET"`

Fields read here: `url.searchParams.get("entity")`.

## src/net/dashboard-api/routing.ts

### `url.pathname.startsWith("/api/routing/")`

[Source](../../src/net/dashboard-api/routing.ts#L59)

- Guard: `!url.pathname.startsWith("/api/routing/")`

### `url.pathname === "/api/routing/overview"`

[Source](../../src/net/dashboard-api/routing.ts#L69)

- Guard: `url.pathname === "/api/routing/overview" && method === "GET"`
- Guard: `method === "GET"`

Fields read here: `reply( router.overview( url.searchParams.get("after") ?? "", routingLimit(url.searchParams.get("limit")), url.searchParams.get("attention") === "true", ), )`, `router.overview( url.searchParams.get("after") ?? "", routingLimit(url.searchParams.get("limit")), url.searchParams.get("attention") === "true", )`, `routingLimit(url.searchParams.get("limit"))`, `url.searchParams.get("after")`, `url.searchParams.get("attention")`, `url.searchParams.get("limit")`.

### `url.pathname === "/api/routing/sync"`

[Source](../../src/net/dashboard-api/routing.ts#L77)

- Guard: `url.pathname === "/api/routing/sync" && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname.match( /^\/api\/routing\/sessions\/([^/]+)\/channels(?:\/([^/]+)\/messages)?$/, )`

[Source](../../src/net/dashboard-api/routing.ts#L79)

- Guard: `channelMatch`
- Guard: `method === "GET"`
- Guard: `method === "POST"`

Fields read here: `Number(url.searchParams.get("after") ?? 0)`, `reply( router.channelEvents( sessionId, channelId, Number(url.searchParams.get("after") ?? 0), routingLimit(url.searchParams.get("limit")), ), )`, `router.channelEvents( sessionId, channelId, Number(url.searchParams.get("after") ?? 0), routingLimit(url.searchParams.get("limit")), )`, `routingLimit(url.searchParams.get("limit"))`, `url.searchParams.get("after")`, `url.searchParams.get("limit")`.

### `url.pathname === "/api/routing/sessions"`

[Source](../../src/net/dashboard-api/routing.ts#L123)

- Guard: `url.pathname === "/api/routing/sessions"`
- Guard: `method === "POST"`
- Guard: `method === "GET"`

Fields read here: `reply( router.list( url.searchParams.get("after") ?? "", routingLimit(url.searchParams.get("limit")), ), )`, `router.list( url.searchParams.get("after") ?? "", routingLimit(url.searchParams.get("limit")), )`, `routingLimit(url.searchParams.get("limit"))`, `url.searchParams.get("after")`, `url.searchParams.get("limit")`.

### `url.pathname.match( /^\/api\/routing\/sessions\/([^/]+)(?:\/(events&#124;heartbeat&#124;leave&#124;inbox&#124;messages&#124;deliveries&#124;runtime&#124;control)(?:\/([^/]+)(?:\/(ack))?)?)?$/, )`

[Source](../../src/net/dashboard-api/routing.ts#L133)

- Guard: `match`
- Guard: `method === "GET"`
- Guard: `method === "POST"`

Fields read here: `Number(url.searchParams.get("after") ?? 0)`, `control`, `reply( router.events( id, Number(url.searchParams.get("after") ?? 0), routingLimit(url.searchParams.get("limit")), ), )`, `reply({ messages: router.deliveries(id, routingLimit(url.searchParams.get("limit"))), })`, `reply({ messages: router.inbox(id, routingLimit(url.searchParams.get("limit"))), })`, `router.deliveries(id, routingLimit(url.searchParams.get("limit")))`, `router.events( id, Number(url.searchParams.get("after") ?? 0), routingLimit(url.searchParams.get("limit")), )`, `router.inbox(id, routingLimit(url.searchParams.get("limit")))`, `routingLimit(url.searchParams.get("limit"))`, `url.searchParams.get("after")`, `url.searchParams.get("limit")`.

## src/net/dashboard-api/system.ts

### `url.pathname === "/api/logout"`

[Source](../../src/net/dashboard-api/system.ts#L160)

- Guard: `url.pathname === "/api/logout" && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname === "/api/world"`

[Source](../../src/net/dashboard-api/system.ts#L166)

- Guard: `url.pathname === "/api/world"`

### `url.pathname === "/api/entities"`

[Source](../../src/net/dashboard-api/system.ts#L169)

- Guard: `url.pathname === "/api/entities"`

### `url.pathname === "/api/events"`

[Source](../../src/net/dashboard-api/system.ts#L172)

- Guard: `url.pathname === "/api/events"`

### `url.pathname === "/api/traces"`

[Source](../../src/net/dashboard-api/system.ts#L175)

- Guard: `url.pathname === "/api/traces" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/evidence/receipts"`

[Source](../../src/net/dashboard-api/system.ts#L178)

- Guard: `url.pathname === "/api/evidence/receipts" && method === "GET" && db`
- Guard: `method === "GET"`

Fields read here: `Number(url.searchParams.get("limit"))`, `url.searchParams.get("limit")`.

### `url.pathname === "/api/evidence/checkpoint"`

[Source](../../src/net/dashboard-api/system.ts#L188)

- Guard: `url.pathname === "/api/evidence/checkpoint" && method === "GET" && db`
- Guard: `method === "GET"`

Fields read here: `Response.json(exported, { headers: url.searchParams.get("download") === "1" ? { "Content-Disposition": 'attachment; filename="marina-evidence-checkpoint.json"' } : undefined, })`, `url.searchParams.get("download")`.

### `url.pathname === "/api/logs"`

[Source](../../src/net/dashboard-api/system.ts#L213)

- Guard: `url.pathname === "/api/logs" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/system"`

[Source](../../src/net/dashboard-api/system.ts#L216)

- Guard: `url.pathname === "/api/system"`

### `url.pathname === "/api/principals"`

[Source](../../src/net/dashboard-api/system.ts#L219)

- Guard: `url.pathname === "/api/principals" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname.match(/^\/api\/principals\/([^/]+)\/status$/)`

[Source](../../src/net/dashboard-api/system.ts#L222)

- Guard: `principalStatusMatch && method === "POST" && db`
- Guard: `method === "POST"`

Fields read here: `error`, `status`.

### `url.pathname === "/api/collective/variants"`

[Source](../../src/net/dashboard-api/system.ts#L237)

- Guard: `url.pathname === "/api/collective/variants" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/federation/peers"`

[Source](../../src/net/dashboard-api/system.ts#L244)

- Guard: `url.pathname === "/api/federation/peers" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/federation/peers"`

[Source](../../src/net/dashboard-api/system.ts#L247)

- Guard: `url.pathname === "/api/federation/peers" && method === "POST" && db`
- Guard: `method === "POST"`

Fields read here: `baseUrl`, `capabilities`, `error`, `name`, `publicKey`, `schema`, `signature`, `worldId`.

### `url.pathname.match(/^\/api\/federation\/peers\/([^/]+)\/trust$/)`

[Source](../../src/net/dashboard-api/system.ts#L327)

- Guard: `federationTrustMatch && method === "POST" && db`
- Guard: `method === "POST"`

Fields read here: `error`, `trust`.

### `url.pathname === "/api/collective/variants"`

[Source](../../src/net/dashboard-api/system.ts#L339)

- Guard: `url.pathname === "/api/collective/variants" && method === "POST" && db`
- Guard: `method === "POST"`

Fields read here: `error`, `hypothesis`, `name`, `parentVariantId`, `worldTemplate`.

### `url.pathname.match( /^\/api\/collective\/variants\/([^/]+)\/(start&#124;stop&#124;promote)$/, )`

[Source](../../src/net/dashboard-api/system.ts#L369)

- Guard: `collectiveActionMatch && method === "POST" && db`
- Guard: `method === "POST"`

Fields read here: `error`, `evidenceRefs`, `rationale`.

### `url.pathname === "/api/security-status"`

[Source](../../src/net/dashboard-api/system.ts#L398)

- Guard: `url.pathname === "/api/security-status" && method === "GET"`
- Guard: `method === "GET"`

## src/net/dashboard-api/world.ts

### `url.pathname.match(/^\/api\/coordination\/tasks\/(\d+)$/)`

[Source](../../src/net/dashboard-api/world.ts#L418)

- Guard: `taskDetailMatch && db`

### `url.pathname.match(/^\/api\/coding\/runs\/([^/]+)$/)`

[Source](../../src/net/dashboard-api/world.ts#L424)

- Guard: `runMatch && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname.match(/^\/api\/coding\/session\/([^/]+)\/artifacts$/)`

[Source](../../src/net/dashboard-api/world.ts#L435)

- Guard: `codingArtifactsMatch && method === "GET" && db`
- Guard: `method === "GET"`

Fields read here: `clampLimit(url.searchParams.get("limit"), 100)`, `url.searchParams.get("kind")`, `url.searchParams.get("limit")`.

### `url.pathname.match(/^\/api\/coding\/session\/([^/]+)$/)`

[Source](../../src/net/dashboard-api/world.ts#L444)

- Guard: `codingSessionDetailMatch && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/coding/sessions"`

[Source](../../src/net/dashboard-api/world.ts#L456)

- Guard: `url.pathname === "/api/coding/sessions" && method === "GET" && db`
- Guard: `method === "GET"`

Fields read here: `clampLimit(url.searchParams.get("limit"), 10)`, `url.searchParams.get("createdBy")`, `url.searchParams.get("limit")`.

### `url.pathname.match(/^\/api\/coordination\/boards\/(.+)\/posts$/)`

[Source](../../src/net/dashboard-api/world.ts#L466)

- Guard: `boardPostsMatch && db`

### `url.pathname.match( /^\/api\/coordination\/channels\/(.+)\/messages$/, )`

[Source](../../src/net/dashboard-api/world.ts#L471)

- Guard: `channelMessagesMatch && db`

### `url.pathname.match(/^\/api\/coordination\/boards\/(.+)$/)`

[Source](../../src/net/dashboard-api/world.ts#L478)

- Guard: `boardDetailMatch && db`

### `url.pathname.match(/^\/api\/coordination\/groups\/(.+)$/)`

[Source](../../src/net/dashboard-api/world.ts#L483)

- Guard: `groupDetailMatch && db`

### `url.pathname.match(/^\/api\/coordination\/channels\/(.+)$/)`

[Source](../../src/net/dashboard-api/world.ts#L488)

- Guard: `channelDetailMatch && db`

### `url.pathname.match(/^\/api\/rooms\/(.+)$/)`

[Source](../../src/net/dashboard-api/world.ts#L493)

- Guard: `roomMatch`

### `url.pathname.match(/^\/api\/entities\/([^/]+)\/canvas$/)`

[Source](../../src/net/dashboard-api/world.ts#L503)

- Guard: `entityCanvasMatch && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/feed"`

[Source](../../src/net/dashboard-api/world.ts#L554)

- Guard: `url.pathname === "/api/feed" && method === "GET" && db`
- Guard: `method === "GET"`

Fields read here: `Number.parseInt(url.searchParams.get("limit") ?? "", 10)`, `Number.parseInt(url.searchParams.get("since") ?? "", 10)`, `Number.parseInt(url.searchParams.get("until") ?? "", 10)`, `url.searchParams.get("entity")`, `url.searchParams.get("kind")`, `url.searchParams.get("limit")`, `url.searchParams.get("since")`, `url.searchParams.get("until")`.

### `url.pathname === "/api/media-jobs"`

[Source](../../src/net/dashboard-api/world.ts#L580)

- Guard: `url.pathname === "/api/media-jobs" && method === "GET" && db`
- Guard: `method === "GET"`

Fields read here: `Number.parseInt(url.searchParams.get("limit") ?? "", 10)`, `url.searchParams.get("entity")`, `url.searchParams.get("limit")`.

### `url.pathname.match(/^\/api\/media-jobs\/([^/]+)\/retry$/)`

[Source](../../src/net/dashboard-api/world.ts#L592)

- Guard: `mediaRetryMatch && method === "POST" && db`
- Guard: `method === "POST"`

### `url.pathname.match(/^\/api\/entities\/([^/]+)\/brief$/)`

[Source](../../src/net/dashboard-api/world.ts#L658)

- Guard: `briefMatch && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname.match(/^\/api\/entities\/([^/]+)\/work$/)`

[Source](../../src/net/dashboard-api/world.ts#L702)

- Guard: `workMatch && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname.match(/^\/api\/entities\/(.+)$/)`

[Source](../../src/net/dashboard-api/world.ts#L720)

- Guard: `entityMatch`
- Guard: `method === "DELETE"`

### `url.pathname === "/api/coordination/boards"`

[Source](../../src/net/dashboard-api/world.ts#L744)

- Guard: `url.pathname === "/api/coordination/boards" && db`

### `url.pathname === "/api/coordination/tasks"`

[Source](../../src/net/dashboard-api/world.ts#L747)

- Guard: `url.pathname === "/api/coordination/tasks" && db`

Fields read here: `clampLimit(url.searchParams.get("limit"), 50)`, `url.searchParams.get("limit")`, `url.searchParams.get("paged")`.

### `url.pathname === "/api/coordination/channels"`

[Source](../../src/net/dashboard-api/world.ts#L757)

- Guard: `url.pathname === "/api/coordination/channels" && db`

### `url.pathname === "/api/coordination/groups"`

[Source](../../src/net/dashboard-api/world.ts#L760)

- Guard: `url.pathname === "/api/coordination/groups" && db`

### `url.pathname === "/api/coordination/projects"`

[Source](../../src/net/dashboard-api/world.ts#L763)

- Guard: `url.pathname === "/api/coordination/projects" && db`

### `url.pathname === "/api/connectors"`

[Source](../../src/net/dashboard-api/world.ts#L766)

- Guard: `url.pathname === "/api/connectors" && db`

### `url.pathname === "/api/commands"`

[Source](../../src/net/dashboard-api/world.ts#L769)

- Guard: `url.pathname === "/api/commands" && db`

### `url.pathname === "/api/room-templates"`

[Source](../../src/net/dashboard-api/world.ts#L782)

- Guard: `url.pathname === "/api/room-templates" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/macros"`

[Source](../../src/net/dashboard-api/world.ts#L785)

- Guard: `url.pathname === "/api/macros" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/experiments"`

[Source](../../src/net/dashboard-api/world.ts#L792)

- Guard: `url.pathname === "/api/experiments" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/evolution-sessions"`

[Source](../../src/net/dashboard-api/world.ts#L795)

- Guard: `url.pathname === "/api/evolution-sessions" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/markets"`

[Source](../../src/net/dashboard-api/world.ts#L801)

- Guard: `url.pathname === "/api/markets" && method === "GET" && db`
- Guard: `method === "GET"`

### `url.pathname === "/api/benchmarks"`

[Source](../../src/net/dashboard-api/world.ts#L804)

- Guard: `url.pathname === "/api/benchmarks" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/recipes"`

[Source](../../src/net/dashboard-api/world.ts#L821)

- Guard: `url.pathname === "/api/recipes" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname.match(/^\/api\/coordination\/projects\/([^/]+)\/orchestration$/)`

[Source](../../src/net/dashboard-api/world.ts#L842)

- Guard: `orchMatch && method === "POST" && db`
- Guard: `method === "POST"`

Fields read here: `orchestration`.

## src/net/entity-api.ts

### `url.pathname.match(/^\/api\/entity\/([^/]+)\/profile\/?$/)`

[Source](../../src/net/entity-api.ts#L71)

- Guard: `match`
- Guard: `method !== "GET"`

## src/net/log-server.ts

### `url.pathname === "/ws"`

[Source](../../src/net/log-server.ts#L63)

- Guard: `url.pathname === "/ws"`

### `url.pathname === "/"`

[Source](../../src/net/log-server.ts#L71)

- Guard: `url.pathname === "/" &#124;&#124; url.pathname === "/index.html"`

### `url.pathname === "/index.html"`

[Source](../../src/net/log-server.ts#L71)

- Guard: `url.pathname === "/" &#124;&#124; url.pathname === "/index.html"`

## src/net/mcp-server.ts

### `url.pathname === "/health"`

[Source](../../src/net/mcp-server.ts#L227)

- Guard: `url.pathname === "/health"`

### `url.pathname === "/mcp"`

[Source](../../src/net/mcp-server.ts#L242)

- Guard: `url.pathname === "/mcp"`

## src/net/media-api.ts

### `url.pathname === "/v1/media"`

[Source](../../src/net/media-api.ts#L53)

- Guard: `url.pathname === "/v1/media" && method === "POST"`
- Guard: `method === "POST"`

Fields read here: `aspectRatio`, `canvasId`, `duration`, `fps`, `height`, `metadata`, `model`, `prompt`, `referenceImage`, `style`, `type`, `width`.

### `url.pathname.match(/^\/v1\/media\/([^/]+)$/)`

[Source](../../src/net/media-api.ts#L132)

- Guard: `match && method === "GET"`
- Guard: `method === "GET"`

## src/net/mem-api.ts

### `path === "/mem"`

[Source](../../src/net/mem-api.ts#L426)

- Guard: `path === "/mem" && method === "GET"`
- Guard: `method === "GET"`

### `path === "/mem/health"`

[Source](../../src/net/mem-api.ts#L431)

- Guard: `path === "/mem/health" && method === "GET"`
- Guard: `method === "GET"`

### `path === "/mem/keys"`

[Source](../../src/net/mem-api.ts#L437)

- Guard: `path === "/mem/keys" && method === "POST"`
- Guard: `method === "POST"`

### `path === "/mem/notes"`

[Source](../../src/net/mem-api.ts#L463)

- Guard: `path === "/mem/notes" && method === "POST"`
- Guard: `method === "POST"`

Fields read here: `links`.

### `path === "/mem/notes"`

[Source](../../src/net/mem-api.ts#L500)

- Guard: `path === "/mem/notes" && method === "GET"`
- Guard: `method === "GET"`

Fields read here: `Math.min(Number(url.searchParams.get("limit")) &#124;&#124; 50, 200)`, `Number(url.searchParams.get("limit"))`, `url.searchParams.get("all")`, `url.searchParams.get("limit")`.

### `path === "/mem/recall"`

[Source](../../src/net/mem-api.ts#L520)

- Guard: `path === "/mem/recall" && method === "GET"`
- Guard: `method === "GET"`

Fields read here: `url.searchParams.get("q")`, `url.searchParams.get("weightImportance")`, `url.searchParams.get("weightRecency")`, `url.searchParams.get("weightRelevance")`, `url.searchParams.get("wi")`, `url.searchParams.get("wr")`, `url.searchParams.get("wrel")`.

### `path === "/mem/context"`

[Source](../../src/net/mem-api.ts#L569)

- Guard: `path === "/mem/context" && method === "GET"`
- Guard: `method === "GET"`

Fields read here: `url.searchParams.get("budget")`, `url.searchParams.get("q")`, `url.searchParams.get("scope")`.

### `path.match(/^\/mem\/notes\/(\d+)$/)`

[Source](../../src/net/mem-api.ts#L606)

- Guard: `noteIdMatch`
- Guard: `method === "GET"`
- Guard: `method === "DELETE"`

### `path.match(/^\/mem\/notes\/(\d+)\/link$/)`

[Source](../../src/net/mem-api.ts#L628)

- Guard: `linkMatch && method === "POST"`
- Guard: `method === "POST"`

Fields read here: `relationship`, `target`.

### `path.match(/^\/mem\/notes\/(\d+)\/trace$/)`

[Source](../../src/net/mem-api.ts#L658)

- Guard: `traceMatch && method === "GET"`
- Guard: `method === "GET"`

Fields read here: `Math.min(Number(url.searchParams.get("depth")) &#124;&#124; 2, 5)`, `Number(url.searchParams.get("depth"))`, `url.searchParams.get("depth")`.

### `path === "/mem/core"`

[Source](../../src/net/mem-api.ts#L672)

- Guard: `path === "/mem/core" && method === "GET"`
- Guard: `method === "GET"`

### `path.match(/^\/mem\/core\/([^/]+)$/)`

[Source](../../src/net/mem-api.ts#L678)

- Guard: `coreKeyMatch`
- Guard: `method === "GET"`
- Guard: `method === "PUT"`
- Guard: `method === "DELETE"`

Fields read here: `value`.

### `path.match(/^\/mem\/core\/([^/]+)\/history$/)`

[Source](../../src/net/mem-api.ts#L712)

- Guard: `coreHistMatch && method === "GET"`
- Guard: `method === "GET"`

Fields read here: `Math.min(Number(url.searchParams.get("limit")) &#124;&#124; 10, 100)`, `Number(url.searchParams.get("limit"))`, `url.searchParams.get("limit")`.

### `path === "/mem/pools"`

[Source](../../src/net/mem-api.ts#L724)

- Guard: `path === "/mem/pools" && method === "GET"`
- Guard: `method === "GET"`

### `path === "/mem/pools"`

[Source](../../src/net/mem-api.ts#L730)

- Guard: `path === "/mem/pools" && method === "POST"`
- Guard: `method === "POST"`

Fields read here: `name`.

### `path.match(/^\/mem\/pools\/([^/]+)(\/.*)?$/)`

[Source](../../src/net/mem-api.ts#L746)

- Guard: `poolMatch`
- Guard: `method === "POST"`
- Guard: `method === "GET"`

Fields read here: `Math.min(Number(url.searchParams.get("limit")) &#124;&#124; 100, 500)`, `Number(url.searchParams.get("limit"))`, `url.searchParams.get("limit")`, `url.searchParams.get("q")`.

### `path === "/mem/stats"`

[Source](../../src/net/mem-api.ts#L799)

- Guard: `path === "/mem/stats" && method === "GET"`
- Guard: `method === "GET"`

## src/net/memory-service-api.ts

### `path === "/v1/memory/health"`

[Source](../../src/net/memory-service-api.ts#L105)

- Guard: `path === "/v1/memory/health" && req.method === "GET"`
- Guard: `req.method === "GET"`

### `path.endsWith("/search")`

[Source](../../src/net/memory-service-api.ts#L139)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/context")`

[Source](../../src/net/memory-service-api.ts#L140)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/query")`

[Source](../../src/net/memory-service-api.ts#L141)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/graph")`

[Source](../../src/net/memory-service-api.ts#L142)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/source_search")`

[Source](../../src/net/memory-service-api.ts#L143)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/plan")`

[Source](../../src/net/memory-service-api.ts#L144)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/execute_plan")`

[Source](../../src/net/memory-service-api.ts#L145)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/retrieve")`

[Source](../../src/net/memory-service-api.ts#L146)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/workflow")`

[Source](../../src/net/memory-service-api.ts#L147)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/federated_retrieve")`

[Source](../../src/net/memory-service-api.ts#L148)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/retrieve_cached")`

[Source](../../src/net/memory-service-api.ts#L149)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/review")`

[Source](../../src/net/memory-service-api.ts#L150)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/cache/get")`

[Source](../../src/net/memory-service-api.ts#L151)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/federated_search")`

[Source](../../src/net/memory-service-api.ts#L152)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/federated_read")`

[Source](../../src/net/memory-service-api.ts#L153)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path.endsWith("/knowledge_graph")`

[Source](../../src/net/memory-service-api.ts#L154)

- Guard: `["POST", "PATCH", "DELETE"].includes(req.method) && !path.endsWith("/search") && !path.endsWith("/context") && !path.endsWith("/query") && !path.endsWith("/graph") && !path.endsWith("/source_search") && !path.endsWith("/plan") && !path.endsWith("/execute_plan") && !path.endsWith("/retrieve") && !path.endsWith("/workflow") && !path.endsWith("/federated_retrieve") && !path.endsWith("/retrieve_cached") && !path.endsWith("/review") && !path.endsWith("/cache/get") && !path.endsWith("/federated_search") && !path.endsWith("/federated_read") && !path.endsWith("/knowledge_graph") && (!key &#124;&#124; key.length > 128)`

### `path === "/v1/memory/assistance"`

[Source](../../src/net/memory-service-api.ts#L164)

- Guard: `path === "/v1/memory/assistance" && req.method === "GET"`
- Guard: `req.method === "GET"`

Fields read here: `Number(url.searchParams.get("limit"))`, `json( repo.assistance.list(actor, { open: open === "true", limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined, cursor: url.searchParams.get("cursor") ?? undefined, }), )`, `repo.assistance.list(actor, { open: open === "true", limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined, cursor: url.searchParams.get("cursor") ?? undefined, })`, `url.searchParams.get("cursor")`, `url.searchParams.get("limit")`, `url.searchParams.get("open")`, `url.searchParams.has("limit")`.

### `path.match( /^\/v1\/memory\/assistance\/([^/]+)(?:\/(claim&#124;heartbeat&#124;read&#124;finish&#124;cancel&#124;delegate&#124;adopt))?$/, )`

[Source](../../src/net/memory-service-api.ts#L176)

- Guard: `assistance`
- Guard: `req.method === "GET"`
- Guard: `req.method === "POST"`

Fields read here: `lease_token`.

### `path === "/v1/memory/usage"`

[Source](../../src/net/memory-service-api.ts#L219)

- Guard: `path === "/v1/memory/usage" && req.method === "GET"`
- Guard: `req.method === "GET"`

### `path === "/v1/memory"`

[Source](../../src/net/memory-service-api.ts#L220)

- Guard: `path === "/v1/memory" && req.method === "GET"`
- Guard: `req.method === "GET"`

### `path === "/v1/memory/me"`

[Source](../../src/net/memory-service-api.ts#L221)

- Guard: `path === "/v1/memory/me" && req.method === "GET"`
- Guard: `req.method === "GET"`

### `path === "/v1/memory/spaces"`

[Source](../../src/net/memory-service-api.ts#L227)

- Guard: `path === "/v1/memory/spaces"`
- Guard: `req.method === "GET"`
- Guard: `req.method === "POST"`

Fields read here: `name`.

### `path.match(/^\/v1\/memory\/spaces\/([^/]+)(?:\/(.*))?$/)`

[Source](../../src/net/memory-service-api.ts#L234)

- Guard: `!match`

### `rest === "assistance"`

[Source](../../src/net/memory-service-api.ts#L238)

- Guard: `rest === "assistance" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "knowledge_graph"`

[Source](../../src/net/memory-service-api.ts#L244)

- Guard: `rest === "knowledge_graph" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "federation_mounts"`

[Source](../../src/net/memory-service-api.ts#L246)

- Guard: `rest === "federation_mounts" && req.method === "GET"`
- Guard: `req.method === "GET"`

### `rest === "federated_search"`

[Source](../../src/net/memory-service-api.ts#L250)

- Guard: `rest === "federated_search" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "federated_read"`

[Source](../../src/net/memory-service-api.ts#L259)

- Guard: `rest === "federated_read" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "bundle"`

[Source](../../src/net/memory-service-api.ts#L268)

- Guard: `rest === "bundle" && req.method === "GET"`
- Guard: `req.method === "GET"`

### `rest === "bundle"`

[Source](../../src/net/memory-service-api.ts#L269)

- Guard: `rest === "bundle" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "transfer"`

[Source](../../src/net/memory-service-api.ts#L274)

- Guard: `rest === "transfer" && req.method === "GET"`
- Guard: `req.method === "GET"`

Fields read here: `json(repo.exportPage(actor, space, url.searchParams.get("cursor") ?? undefined))`, `repo.exportPage(actor, space, url.searchParams.get("cursor") ?? undefined)`, `url.searchParams.get("cursor")`.

### `rest === "transfers"`

[Source](../../src/net/memory-service-api.ts#L276)

- Guard: `rest === "transfers" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "transfers"`

[Source](../../src/net/memory-service-api.ts#L278)

- Guard: `rest === "transfers" && req.method === "GET"`
- Guard: `req.method === "GET"`

Fields read here: `Number(url.searchParams.get("limit"))`, `json( repo.transfers(actor, space, { state: (url.searchParams.get( "state", ) as import("../sdk/memory-transfer").MemoryTransferStatus["state"]) ?? undefined, expired: expired === null ? undefined : expired === "true", limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined, cursor: url.searchParams.get("cursor") ?? undefined, }), )`, `repo.transfers(actor, space, { state: (url.searchParams.get( "state", ) as import("../sdk/memory-transfer").MemoryTransferStatus["state"]) ?? undefined, expired: expired === null ? undefined : expired === "true", limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined, cursor: url.searchParams.get("cursor") ?? undefined, })`, `url.searchParams.get("cursor")`, `url.searchParams.get("expired")`, `url.searchParams.get("limit")`, `url.searchParams.has("limit")`.

### `rest.match(/^transfers\/([^/]+)(?:\/(pages&#124;commit&#124;abort))?$/)`

[Source](../../src/net/memory-service-api.ts#L294)

- Guard: `transfer`
- Guard: `req.method === "GET"`
- Guard: `req.method === "POST"`

### `rest === "acknowledge"`

[Source](../../src/net/memory-service-api.ts#L314)

- Guard: `rest === "acknowledge" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "json_store"`

[Source](../../src/net/memory-service-api.ts#L316)

- Guard: `rest === "json_store" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "join"`

[Source](../../src/net/memory-service-api.ts#L318)

- Guard: `rest === "join" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "rules"`

[Source](../../src/net/memory-service-api.ts#L320)

- Guard: `rest === "rules" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "rules/run"`

[Source](../../src/net/memory-service-api.ts#L322)

- Guard: `rest === "rules/run" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "rules/materialize"`

[Source](../../src/net/memory-service-api.ts#L324)

- Guard: `rest === "rules/materialize" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "review"`

[Source](../../src/net/memory-service-api.ts#L326)

- Guard: `rest === "review" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "reaffirm"`

[Source](../../src/net/memory-service-api.ts#L328)

- Guard: `rest === "reaffirm" && req.method === "POST"`
- Guard: `req.method === "POST"`

Fields read here: `id`.

### `rest === "resolve"`

[Source](../../src/net/memory-service-api.ts#L341)

- Guard: `rest === "resolve" && req.method === "POST"`
- Guard: `req.method === "POST"`

Fields read here: `id`.

### `rest === "adopt"`

[Source](../../src/net/memory-service-api.ts#L345)

- Guard: `rest === "adopt" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "cache/delete"`

[Source](../../src/net/memory-service-api.ts#L349)

- Guard: `rest === "cache/delete" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "cache/get"`

[Source](../../src/net/memory-service-api.ts#L351)

- Guard: `rest === "cache/get" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "cache/put"`

[Source](../../src/net/memory-service-api.ts#L355)

- Guard: `rest === "cache/put" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "plan"`

[Source](../../src/net/memory-service-api.ts#L359)

- Guard: `rest === "plan" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "execute_plan"`

[Source](../../src/net/memory-service-api.ts#L361)

- Guard: `rest === "execute_plan" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "workflow"`

[Source](../../src/net/memory-service-api.ts#L363)

- Guard: `rest === "workflow" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "federated_retrieve"`

[Source](../../src/net/memory-service-api.ts#L367)

- Guard: `rest === "federated_retrieve" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "retrieve_cached"`

[Source](../../src/net/memory-service-api.ts#L376)

- Guard: `rest === "retrieve_cached" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "retrieve"`

[Source](../../src/net/memory-service-api.ts#L380)

- Guard: `rest === "retrieve" && req.method === "POST"`
- Guard: `req.method === "POST"`

### `rest === "vocabulary"`

[Source](../../src/net/memory-service-api.ts#L382)

- Guard: `rest === "vocabulary"`
- Guard: `req.method === "GET"`
- Guard: `req.method === "POST"`

Fields read here: `Number(url.searchParams.get("version"))`, `definition`, `expected_version`, `json( repo.vocabulary( actor, space, url.searchParams.has("version") ? Number(url.searchParams.get("version")) : undefined, ), )`, `repo.vocabulary( actor, space, url.searchParams.has("version") ? Number(url.searchParams.get("version")) : undefined, )`, `url.searchParams.get("version")`, `url.searchParams.has("version")`.

### `rest === "source_search"`

[Source](../../src/net/memory-service-api.ts#L404)

- Guard: `rest === "source_search" && req.method === "POST"`
- Guard: `req.method === "POST"`

Fields read here: `expansion`, `limit`, `match`, `query`, `session_id`.

### `rest.match(/^sources\/([^/]+)$/)`

[Source](../../src/net/memory-service-api.ts#L419)

- Guard: `source && req.method === "GET"`
- Guard: `req.method === "GET"`

Fields read here: `Number(url.searchParams.get("end"))`, `Number(url.searchParams.get("start") ?? 0)`, `json( repo.sourceRange( actor, space, decodeURIComponent(source[1]!), Number(url.searchParams.get("start") ?? 0), url.searchParams.has("end") ? Number(url.searchParams.get("end")) : undefined, url.searchParams.get("text_hash") ?? undefined, ), )`, `repo.sourceRange( actor, space, decodeURIComponent(source[1]!), Number(url.searchParams.get("start") ?? 0), url.searchParams.has("end") ? Number(url.searchParams.get("end")) : undefined, url.searchParams.get("text_hash") ?? undefined, )`, `url.searchParams.get("end")`, `url.searchParams.get("start")`, `url.searchParams.get("text_hash")`, `url.searchParams.has("end")`.

### `rest === "query"`

[Source](../../src/net/memory-service-api.ts#L431)

- Guard: `rest === "query" && req.method === "POST"`
- Guard: `req.method === "POST"`

Fields read here: `limit`, `name`, `object`, `valid_at`.

### `rest === "graph"`

[Source](../../src/net/memory-service-api.ts#L452)

- Guard: `rest === "graph" && req.method === "POST"`
- Guard: `req.method === "POST"`

Fields read here: `direction`, `limit`, `max_depth`, `predicates`, `subject`, `valid_at`.

### `rest === "reindex"`

[Source](../../src/net/memory-service-api.ts#L485)

- Guard: `rest === "reindex" && req.method === "POST"`
- Guard: `req.method === "POST"`

Fields read here: `cursor`, `expected_generation`, `limit`.

### `rest === "grants"`

[Source](../../src/net/memory-service-api.ts#L512)

- Guard: `rest === "grants" && req.method === "POST"`
- Guard: `req.method === "POST"`

Fields read here: `principal_id`, `role`.

### `rest === "records"`

[Source](../../src/net/memory-service-api.ts#L521)

- Guard: `rest === "records" && req.method === "POST"`
- Guard: `req.method === "POST"`

Fields read here: `mode`.

### `rest.match(/^records\/([^/]+)$/)`

[Source](../../src/net/memory-service-api.ts#L531)

- Guard: `record`
- Guard: `req.method === "GET"`
- Guard: `req.method === "PATCH"`

Fields read here: `expected_version`, `url.searchParams.get("version")`.

### `rest === "search"`

[Source](../../src/net/memory-service-api.ts#L560)

- Guard: `(rest === "search" &#124;&#124; rest === "context") && req.method === "POST"`
- Guard: `req.method === "POST"`

Fields read here: `budget_tokens`.

### `rest === "context"`

[Source](../../src/net/memory-service-api.ts#L560)

- Guard: `(rest === "search" &#124;&#124; rest === "context") && req.method === "POST"`
- Guard: `req.method === "POST"`

Fields read here: `budget_tokens`.

### `rest === "search"`

[Source](../../src/net/memory-service-api.ts#L564)

- Guard: `(rest === "search" &#124;&#124; rest === "context") && req.method === "POST"`
- Guard: `req.method === "POST"`

Fields read here: `budget_tokens`.

### `rest === "sources/batch"`

[Source](../../src/net/memory-service-api.ts#L577)

- Guard: `rest === "sources/batch" && req.method === "POST"`
- Guard: `req.method === "POST"`

Fields read here: `items`.

### `rest === "source_headers"`

[Source](../../src/net/memory-service-api.ts#L581)

- Guard: `rest === "source_headers" && req.method === "GET"`
- Guard: `req.method === "GET"`

Fields read here: `Number(url.searchParams.get("after") ?? 0)`, `Number(url.searchParams.get("limit") ?? 20)`, `integer( Number(url.searchParams.get("after") ?? 0), "after", 0, Number.MAX_SAFE_INTEGER, )`, `integer(Number(url.searchParams.get("limit") ?? 20), "limit", 1, 100)`, `url.searchParams.get("after")`, `url.searchParams.get("limit")`.

### `rest === "sources"`

[Source](../../src/net/memory-service-api.ts#L592)

- Guard: `rest === "sources"`
- Guard: `req.method === "POST"`
- Guard: `req.method === "GET"`

Fields read here: `Number(url.searchParams.get("after") ?? 0)`, `Number(url.searchParams.get("limit") ?? 100)`, `content`, `integer( Number(url.searchParams.get("after") ?? 0), "after", 0, Number.MAX_SAFE_INTEGER, )`, `integer(Number(url.searchParams.get("limit") ?? 100), "limit", 1, 1000)`, `session_id`, `url.searchParams.get("after")`, `url.searchParams.get("limit")`.

### `rest.match(/^checkpoints\/([^/]+)$/)`

[Source](../../src/net/memory-service-api.ts#L613)

- Guard: `checkpoint`
- Guard: `req.method === "GET"`
- Guard: `req.method === "POST"`

Fields read here: `data`, `expected_version`, `source_cursor`, `source_ids`.

### `rest.match(/^jobs\/([^/]+)$/)`

[Source](../../src/net/memory-service-api.ts#L633)

- Guard: `job && req.method === "GET"`
- Guard: `req.method === "GET"`

### `rest === "forget"`

[Source](../../src/net/memory-service-api.ts#L636)

- Guard: `rest === "forget" && req.method === "POST"`
- Guard: `req.method === "POST"`

Fields read here: `all`, `expected_generation`, `field`, `record_ids`, `source_ids`.

### `rest === "export"`

[Source](../../src/net/memory-service-api.ts#L674)

- Guard: `rest === "export" && req.method === "GET"`
- Guard: `req.method === "GET"`

## src/net/model-api.ts

### `url.pathname.startsWith("/v1/responses/")`

[Source](../../src/net/model-api.ts#L135)

- Guard: `rateLimiter && (method === "POST" &#124;&#124; isResponsesStateOp)`
- Guard: `method === "POST"`
- Guard: `method === "GET"`

### `url.pathname.startsWith("/v1/media")`

[Source](../../src/net/model-api.ts#L144)

- Guard: `url.pathname.startsWith("/v1/media")`

### `url.pathname === "/v1/forecast"`

[Source](../../src/net/model-api.ts#L149)

- Guard: `url.pathname === "/v1/forecast" && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname === "/v1/decisions"`

[Source](../../src/net/model-api.ts#L155)

- Guard: `(url.pathname === "/v1/decisions" &#124;&#124; url.pathname === "/v1/systemone") && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname === "/v1/systemone"`

[Source](../../src/net/model-api.ts#L155)

- Guard: `(url.pathname === "/v1/decisions" &#124;&#124; url.pathname === "/v1/systemone") && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname === "/v1/decisions/models"`

[Source](../../src/net/model-api.ts#L159)

- Guard: `(url.pathname === "/v1/decisions/models" &#124;&#124; url.pathname === "/v1/systemone/models") && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/v1/systemone/models"`

[Source](../../src/net/model-api.ts#L159)

- Guard: `(url.pathname === "/v1/decisions/models" &#124;&#124; url.pathname === "/v1/systemone/models") && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/v1/models"`

[Source](../../src/net/model-api.ts#L166)

- Guard: `url.pathname === "/v1/models" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/v1/chat/completions"`

[Source](../../src/net/model-api.ts#L171)

- Guard: `url.pathname === "/v1/chat/completions" && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname === "/v1/messages"`

[Source](../../src/net/model-api.ts#L180)

- Guard: `url.pathname === "/v1/messages" && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname === "/v1/responses"`

[Source](../../src/net/model-api.ts#L221)

- Guard: `url.pathname === "/v1/responses" && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname.startsWith("/v1/responses/")`

[Source](../../src/net/model-api.ts#L224)

- Guard: `url.pathname.startsWith("/v1/responses/") && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname.startsWith("/v1/responses/")`

[Source](../../src/net/model-api.ts#L228)

- Guard: `url.pathname.startsWith("/v1/responses/") && method === "DELETE"`
- Guard: `method === "DELETE"`

### `url.pathname === "/v1/health"`

[Source](../../src/net/model-api.ts#L234)

- Guard: `url.pathname === "/v1/health" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/tags"`

[Source](../../src/net/model-api.ts#L249)

- Guard: `url.pathname === "/api/tags" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/version"`

[Source](../../src/net/model-api.ts#L254)

- Guard: `url.pathname === "/api/version" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/ps"`

[Source](../../src/net/model-api.ts#L259)

- Guard: `url.pathname === "/api/ps" && method === "GET"`
- Guard: `method === "GET"`

### `url.pathname === "/api/show"`

[Source](../../src/net/model-api.ts#L264)

- Guard: `url.pathname === "/api/show" && method === "POST"`
- Guard: `method === "POST"`

Fields read here: `model`, `name`.

### `url.pathname === "/api/chat"`

[Source](../../src/net/model-api.ts#L280)

- Guard: `url.pathname === "/api/chat" && method === "POST"`
- Guard: `method === "POST"`

### `url.pathname === "/api/generate"`

[Source](../../src/net/model-api.ts#L285)

- Guard: `url.pathname === "/api/generate" && method === "POST"`
- Guard: `method === "POST"`

## src/net/model-api/ollama.ts

### `pathname.startsWith("/v1/")`

[Source](../../src/net/model-api/ollama.ts#L519)

## src/net/model-api/shared.ts

### `rest === "*"`

[Source](../../src/net/model-api/shared.ts#L131)

- Guard: `rest === "*"`

## src/net/orchestration-api.ts

### `url.pathname.startsWith('${PREFIX}/')`

[Source](../../src/net/orchestration-api.ts#L73)

- Guard: `url.pathname !== PREFIX && !url.pathname.startsWith('${PREFIX}/')`

### `url.pathname === '${PREFIX}/patterns'`

[Source](../../src/net/orchestration-api.ts#L75)

- Guard: `url.pathname === '${PREFIX}/patterns'`
- Guard: `req.method === "OPTIONS"`
- Guard: `req.method !== "GET"`
- Guard: `req.method !== "HEAD"`

## src/net/websocket-server.ts

### `url.pathname === "/dashboard-ws"`

[Source](../../src/net/websocket-server.ts#L384)

- Guard: `isWsUpgrade`

Fields read here: `url.searchParams.get("canvas")`.

### `url.pathname === "/ws"`

[Source](../../src/net/websocket-server.ts#L385)

- Guard: `isWsUpgrade`

Fields read here: `url.searchParams.get("canvas")`.

### `url.pathname === "/canvas-ws"`

[Source](../../src/net/websocket-server.ts#L386)

- Guard: `isWsUpgrade`

Fields read here: `url.searchParams.get("canvas")`.

### `url.pathname === "/dashboard-ws"`

[Source](../../src/net/websocket-server.ts#L426)

- Guard: `isWsUpgrade`
- Guard: `url.pathname === "/dashboard-ws"`

### `url.pathname === "/ws"`

[Source](../../src/net/websocket-server.ts#L442)

- Guard: `isWsUpgrade`
- Guard: `url.pathname === "/ws"`

### `url.pathname === "/canvas-ws"`

[Source](../../src/net/websocket-server.ts#L452)

- Guard: `isWsUpgrade`
- Guard: `url.pathname === "/canvas-ws"`

Fields read here: `url.searchParams.get("canvas")`.

### `url.pathname.startsWith("/assets/")`

[Source](../../src/net/websocket-server.ts#L473)

- Guard: `url.pathname.startsWith("/assets/") && self.storage`

### `url.pathname.startsWith("/api/assets")`

[Source](../../src/net/websocket-server.ts#L481)

- Guard: `url.pathname.startsWith("/api/assets") && self.db && self.storage`

### `url.pathname.startsWith("/api/canvases")`

[Source](../../src/net/websocket-server.ts#L486)

- Guard: `url.pathname.startsWith("/api/canvases") && self.db`

### `url.pathname === "/mem"`

[Source](../../src/net/websocket-server.ts#L508)

- Guard: `(url.pathname === "/mem" &#124;&#124; url.pathname.startsWith("/mem/")) && self.db`

### `url.pathname.startsWith("/mem/")`

[Source](../../src/net/websocket-server.ts#L508)

- Guard: `(url.pathname === "/mem" &#124;&#124; url.pathname.startsWith("/mem/")) && self.db`

### `url.pathname === "/api/probe"`

[Source](../../src/net/websocket-server.ts#L519)

- Guard: `url.pathname === "/api/probe" && self.db`

### `url.pathname.startsWith("/api/entity/")`

[Source](../../src/net/websocket-server.ts#L533)

- Guard: `url.pathname.startsWith("/api/entity/") && self.db`

### `url.pathname.startsWith("/v1/memory")`

[Source](../../src/net/websocket-server.ts#L544)

- Guard: `url.pathname.startsWith("/v1/memory") && self.memoryService`

### `url.pathname.startsWith("/v1/")`

[Source](../../src/net/websocket-server.ts#L548)

- Guard: `url.pathname.startsWith("/v1/")`

### `url.pathname.startsWith("/api/auth")`

[Source](../../src/net/websocket-server.ts#L574)

- Guard: `url.pathname.startsWith("/api/auth")`

### `url.pathname.startsWith("/api/orchestration/")`

[Source](../../src/net/websocket-server.ts#L588)

- Guard: `url.pathname.startsWith("/api/orchestration/")`
- Guard: `req.method === "OPTIONS"`

### `url.pathname.startsWith("/api/")`

[Source](../../src/net/websocket-server.ts#L608)

- Guard: `url.pathname.startsWith("/api/")`

### `url.pathname === "/health"`

[Source](../../src/net/websocket-server.ts#L619)

- Guard: `url.pathname === "/health"`

### `url.pathname === "/dashboard"`

[Source](../../src/net/websocket-server.ts#L628)

- Guard: `url.pathname === "/dashboard" &#124;&#124; url.pathname.startsWith("/dashboard/")`

### `url.pathname.startsWith("/dashboard/")`

[Source](../../src/net/websocket-server.ts#L628)

- Guard: `url.pathname === "/dashboard" &#124;&#124; url.pathname.startsWith("/dashboard/")`

### `url.pathname === "/dashboard"`

[Source](../../src/net/websocket-server.ts#L630)

- Guard: `url.pathname === "/dashboard" &#124;&#124; url.pathname.startsWith("/dashboard/")`

### `url.pathname === "/canvas"`

[Source](../../src/net/websocket-server.ts#L654)

- Guard: `url.pathname === "/canvas" &#124;&#124; url.pathname.startsWith("/canvas/")`

### `url.pathname.startsWith("/canvas/")`

[Source](../../src/net/websocket-server.ts#L654)

- Guard: `url.pathname === "/canvas" &#124;&#124; url.pathname.startsWith("/canvas/")`

### `url.pathname === "/who"`

[Source](../../src/net/websocket-server.ts#L661)

- Guard: `url.pathname === "/who" &#124;&#124; url.pathname.startsWith("/who/")`

### `url.pathname.startsWith("/who/")`

[Source](../../src/net/websocket-server.ts#L661)

- Guard: `url.pathname === "/who" &#124;&#124; url.pathname.startsWith("/who/")`

### `url.pathname === "/terminal"`

[Source](../../src/net/websocket-server.ts#L665)

- Guard: `url.pathname === "/terminal"`

### `url.pathname === "/"`

[Source](../../src/net/websocket-server.ts#L669)

- Guard: `url.pathname === "/"`

### `url.pathname === "/chat"`

[Source](../../src/net/websocket-server.ts#L673)

- Guard: `url.pathname === "/chat"`

### `url.pathname === "/ask"`

[Source](../../src/net/websocket-server.ts#L677)

- Guard: `url.pathname === "/ask"`
