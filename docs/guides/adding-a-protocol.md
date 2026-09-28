# Adding a participant protocol

A transport translates wire messages and authenticates a connection. Marina owns
identity, permissions, command execution, onboarding and memory retrieval. Start from
`src/net/mcp-server.ts` or `src/net/websocket-server.ts`, depending on the transport.

1. **Bind identity on the server.** Create a `Connection` with a unique ID and the
   actual peer address. Use the established login/reconnect path. Never accept a
   caller-supplied entity ID as authority or derive peer trust from arbitrary headers.
   Apply HTTP/session/admission limits before expensive work.
2. **Reuse discovery.** Obtain `commandManifest(engine.commands, ...)` with the
   participant's current room, rank and mode. Use the SDK's renderers/command forms
   for your presentation. Treat descriptions as metadata, not execution permission.
   Room overrides without metadata must remain opaque. The [generated builtin
   reference](../reference/commands.md) is a baseline, not a deployed-world snapshot.
3. **Route execution centrally.** Use the engine command path and preserve FIFO for
   a participant. Structured world actions use `/command` so Code Mode cannot change
   their meaning. Free-text input retains its modal grammar. Revalidate exposed forms
   inside the execution queue, after preceding moves/reloads finish. Do not bypass
   rank, safety gates, room precedence, audit events or rate limits.
4. **Share onboarding.** Use `onboardParticipant` for a connected resident, passing
   resume state. Stateless opted-in interfaces render `participantOrientation`
   without running arrival actions. Do not copy a static command roster or quest list.
5. **Bind context to the caller.** Use `previewParticipantContext` for a resident's
   explicit query, or the same `buildUnifiedContext` policy used by agent prompts.
   Recheck the connection identity before delivery. Preserve provenance tiers,
   byte budgets, degradation notices and opt-out controls. Retrieval does not grant
   recall credit or expose another resident's private prompt. Context delivered after
   an action informs the next decision; do not label it as that action's explanation.
6. **Handle cancellation honestly.** A queued, unstarted action can be cancelled.
   Do not release its FIFO slot while an executing write is still running. A client
   timeout is an uncertain outcome; preserve receipts and avoid automatic duplicate
   writes. Optional context failure must not rewrite a successful action as a failure.
7. **Own lifecycle resources.** Track admitted requests with `RequestDrain`, stop new
   admission, drain pending work, remove connections, await adapter/server close,
   then allow database close. Track timers and spawned processes at their owner.
8. **Prove parity.** Cover login/resume, room overrides, rank/gate denial, schema
   replacement while queued, cancellation, context edits/deletion/revocation, private
   data exclusion, and disconnect/reconnect with the same name. Exercise real transport
   requests and a graceful shutdown; use the participation and MCP tests as examples.

Use branded IDs at boundaries and the central Logger with structured, redacted data.
Keep credentials, raw private context and bearer tokens out of public feeds. Add a
connection guide, configuration reference if needed, and a browser/CLI example for
the new protocol. Run `make check`, the affected tests, and the full release checks
before publishing a new entry point.
