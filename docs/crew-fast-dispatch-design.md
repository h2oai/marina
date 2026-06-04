# Crew Fast-Dispatch Design

Three primitives that drop coordinator↔specialist round-trip latency from ~10–14 s to ~3–5 s. Landed 2026-05-08 (commits `f4a9a1c`, `b409166`, `80efa35`).

## The problem

When a coordinator agent (e.g. `answerer`) delegates a question to a specialist (e.g. `mathematician`), the round trip used to cost two full autonomous-loop cycles per side:

1. Coordinator emits `tell mathematician compute X` and returns immediately.
2. Mathematician's loop tick eventually picks up the perception, builds a continuation prompt, calls the LLM, emits `tell answerer …`.
3. Coordinator's loop tick eventually picks up the reply, builds another continuation prompt, calls the LLM, moves on.

Each "eventually" was bounded by the loop cycle delay (up to ~2 s) and each LLM call ate the full continuation-prompt cost. Net: 4 LLM turns and 8 cycle-delay quanta per Q→A — about 10–14 s of wall-clock latency for a single handoff.

## Fix #1 — `tellAndAwait` + `awaitReply`

`MarinaClient.tellAndAwait(target, message, timeoutMs)` (see `src/sdk/client.ts`) registers a perception listener **before** firing the `tell` command and then awaits the next inbound `tell` from `target`. Registering listener-first eliminates the race where the reply could arrive before the listener is armed.

Exposed to LLMs through the typed `marina_tell` tool's `awaitReply: true` parameter (see `src/agent/tools/index.ts`). When `awaitReply` is set the tool call is held open across one full round trip, so the coordinator's turn pays **one** continuation-prompt cost instead of two.

Default `timeoutMs` is 30 s. A hung specialist therefore blocks the coordinator for up to that timeout — we chose that trade-off because in crew workflows synchronous coordination matters more than partial-failure throughput.

## Fix #2 — `crewResponder` on `AgentConfig`

Thin specialists do not need the full cognitive cycle: their whole job is "wake on perception, answer the coordinator, sleep." Setting `crewResponder: true` (see `src/agent/agent-types.ts`) causes the autonomous loop to:

- Skip ticks when no perceptions are pending — no LLM call, no token cost, no autonomous drift between coordinator messages.
- Suppress the Memory Health, Learning Signal, and ACE Reflection sections in the continuation prompt (those exist for self-driven agents).
- Skip idle consolidation entirely.

`inferCrewResponder(role)` (see `src/agent/agent-runtime.ts`) infers the flag from role name. Defaults `true` for: `mathematician`, `skeptic`, `format-verifier`, `historian`, `scholar`, `crew-reflector`, `translator`. Coordinator roles (`answerer`, `councilor`, `debater`, `decomposer`) deliberately stay `false` — they need the cognitive cycle to drive dispatch decisions between specialist replies.

## Fix #3 — `InterruptibleWaiter`

`src/agent/interruptible-waiter.ts` is a small helper: a `sleep(ms)` that can be cut short by `wake()`. The autonomous loop's cycle-delay sleep uses one of these; the perception handler calls `cycleWaiter.wake()` after pushing into `pendingPerceptions`, so the loop wakes immediately instead of waiting up to `loopCycleDelay`.

Used only for the cycle-delay sleep. Rate-limit backoffs (LLM-error, loop-exception, streaming-guard) intentionally stay on the original non-wakeable `sleep()` — those exist precisely to enforce a cool-off, and waking them would defeat the purpose.

## Combined effect

A coordinator using `awaitReply` to address a `crewResponder` specialist whose loop sleep uses an `InterruptibleWaiter`:

- Coordinator turn: 1 LLM call; tool call held open through the round trip.
- Specialist wakeup: instant (no cycle-delay wait); 1 LLM call; sections suppressed.
- Specialist sleep: skipped (`crewResponder` + empty perceptions = no LLM call).
- Coordinator unblocks: returns inside the same tool call.

Net: 2 LLM turns instead of 4, roughly 3–5 s instead of 10–14 s.

## Boundaries

- Do **not** use `awaitReply` for room-wide or channel broadcasts. `tell` is point-to-point; broadcasts stay fire-and-forget.
- Do **not** set `crewResponder: true` on a coordinator role. The coordinator's whole job is autonomous decision-making between specialist turns.
- Do **not** `wake()` the `InterruptibleWaiter` on rate-limit recovery — that would defeat the cool-off.

## Where to look in the code

| Concern | File |
| --- | --- |
| `tellAndAwait` primitive | `src/sdk/client.ts` |
| `marina_tell` typed tool + `awaitReply` | `src/agent/tools/index.ts` |
| `crewResponder` field on `AgentConfig` | `src/agent/agent-types.ts` |
| `inferCrewResponder(role)` | `src/agent/agent-runtime.ts` |
| Autonomous loop skip + section suppression | `src/agent/lean-agent-adapter.ts` |
| Wakeable cycle sleep | `src/agent/interruptible-waiter.ts` |
