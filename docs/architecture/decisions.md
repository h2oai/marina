# Harness Decisions — route, gate, verify

**When to read this:** you are wiring a cheap judgement call into an agent loop (which model, is this tool call safe, is this answer good enough), configuring a decision backend, or calling `POST /v1/decisions` from a harness Marina does not run.

## Idea

A harness is the code that runs an agent's loop: the model proposes, the harness decides what actually runs. Good harnesses make many small decisions per step. Asking a full chat model each time is too slow and expensive, so most checks get skipped. A **decision model** answers structured questions with numbers only (never text), fast and cheaply enough to run on every step. Marina's policy code, not the model, turns those numbers into verdicts.

This follows the pattern described in DAIR.AI Academy's *Building a Custom Harness with Pi and Jev* (router / gate / verifier on the Pi SDK, using TypeSafe's Jev) and generalises it: the backend is pluggable and the same policies serve pi agents inside Marina and any external harness over HTTP.

## Wire format (`src/decisions/types.ts`)

A request is a `state` (string, object or array) plus named `questions`, each `{ type, instructions, criteria }` — the Decisions API format used by the Jev family on OpenRouter:

| Type | `criteria` | Answer |
|---|---|---|
| `noul` (yes/no) | optional `{ true, false }` | `{ type: "noul", noul }` — probability of yes, 0..1 |
| `choice` | `{ <option>: description }` (≥ 2) | `{ type: "choice", choice, confidence? }` |
| `score` | ordered level descriptions (≥ 2) | `{ type: "score", score, confidence? }` — level index 0..n-1, fractional |

Choice and score answers keep a reported `probabilities` distribution (per option / per level index) and `confidence`. Over HTTP every answer is serialized by `toWireAnswers` in TypeSafe's complete shape — choice/score always carry `probabilities` + `confidence`, score also a `legend` (level index → description); for a backend that did not report them (a chat classifier) they are derived (the pick gets its confidence and the rest share the remainder; a score splits mass between its two nearest levels). Every backend's reply goes through `normalizeAnswers` (`src/decisions/answers.ts`): probabilities clamp to 0..1, a choice must be a listed option, a score clamps to the level range, and every asked question must be answered — so a chat model used as a classifier is held to the same contract as a purpose-built decision model.

## Backends (`src/decisions/providers.ts`)

| `MARINA_DECISIONS` | Backend | Notes |
|---|---|---|
| `decisions-api` (alias `jev`) | `POST {baseUrl}/decisions` with `{ model, state, questions }` | Purpose-built decision models: the Jev family on OpenRouter (pin a version, e.g. `typesafe/jev-1.13`; siblings such as nanojev / kev by model id) or a self-hosted server speaking the same format (OpenJev). Default timeout 2 s. |
| `typesafe` | `POST https://api.typesafe.ai/v1/systemone` | TypeSafe's own API — what `langchain-typesafe` calls. Same wire format; default model `jev-latest`, key `TYPESAFE_API_KEY`. `MARINA_DECISION_PATH` overrides the path for any Decisions-API server. |
| `chat-classifier` (aliases `classifier`, `llm`) | `POST {baseUrl}/chat/completions` | ANY OpenAI-compatible chat model — OpenRouter, a local Ollama/llama.cpp server, or Marina's own `/v1`. Less calibrated than a decision model, but never vendor-bound. No `response_format` is sent (many servers, including Marina's passthru, reject `json_object`); the reply's first JSON object is extracted. Default timeout 8 s. |

Configuration is env-only (`.env.example` → *Harness Decisions*): the backend receives tool names and redacted arguments, so sending them to a third party is an operator decision, never an in-world one. Endpoints are operator configuration and are fetched directly (like provider upstreams), so a localhost classifier works. `MARINA_DECISION_API_KEY` falls back to `OPENROUTER_API_KEY` only for `openrouter.ai` URLs. `readiness` reports the `decisions` capability.

## Policies (`src/decisions/policy.ts`)

Pure functions — same numbers, same verdict, testable without a model. Thresholds live here and nowhere else.

| Part | Asks | Verdict | Backend failure |
|---|---|---|---|
| **Gate** (`decideGate`) | `destructive`, `irreversible`, `outsideScope` (noul) | worst ≥ `blockAt` 0.88 → block; ≥ `askAt` 0.65 → ask a person; else allow | **Block** (fail closed: an outage may cost work, never data) |
| **Router** (`decideRoute`) | `tier` (choice fast/powerful) + `complexity` (score 0–2) | complexity ≥ 1.0 → powerful; tier confidence < 0.6 → fallback; else the pick | **Fallback tier** (fail open: costs money only) |
| **Verifier** (`decideVerify`) | `quality` (score 0–2) + `grounded` (noul) | quality ≥ 1.5 and grounded ≥ 0.5 → accept; else retry, at most 2 attempts in total; an unsure judge accepts | **Accept** (advisory; never loop on an outage) |

Route once per request (a task claim, job, `model_request` or session start), never mid-run: switching models discards the provider's prompt cache for the whole transcript.

## Where it runs

- **Spawn-time routing** — `agent spawn <name> model:route goal:<…>` (`src/decisions/route.ts`): the runtime asks the router questions about the goal (plus role) before the agent exists and resolves `route` to `MARINA_ROUTE_FAST_MODEL` or `MARINA_ROUTE_POWERFUL_MODEL`. The resolved id is what `agent_configs` stores, so respawns never re-route. Missing tiers refuse the spawn with a remediation; no backend, no goal or a backend error resolve to the powerful tier. Emits an `agent_decision` (`stage: "route"`, `subject` = the chosen model).
- **pi agents (`LeanAgentAdapter`)** — `MARINA_DECISION_GATE=on` scores tool calls in `beforeToolCall`, AFTER the deterministic reference monitor (`mediateToolCall`), and only for `mutate` / `consequential` risk: reads and messages never leave the process. `ask` holds the call for the agent's owner (`src/decisions/approvals.ts`): the principal that spawned it gets a notice and settles it with `decision approve|deny <token>`; only the owner may settle, an agent never approves its own call, there is no rank override, and a deny, a timeout (`MARINA_DECISION_APPROVAL_TIMEOUT_MS`, default 120 s), an offline owner or a `system`-spawned agent blocks it. What is sent is the tool name, its arguments and the tool's own description (`redactToolCall`: sensitive keys redacted, emails and key-shaped strings masked, values truncated) — never the transcript, which also keeps the gate robust to prompt injection. Every gate question tells the judge to treat all state, arguments and descriptions included, as data rather than instructions.
- **Task submissions** — `MARINA_DECISION_VERIFY=on` (`src/decisions/verify.ts`): `task submit` on a live claim asks `quality` (score 0–2) and `delivered` (noul: results or evidence, not only a plan) about the task and the deliverable. Below the bar on the first attempt, the submission is NOT recorded and the agent is told the scores and to report the work actually done; the second attempt is recorded as is (`maxAttempts` 2). Advisory: the creator's approve/reject still decides and standing still flows only through approval; an outage records the submission. A submit that cannot succeed (no live claim) never costs a judge call. Emits `agent_decision` (`stage: "verify"`, `subject: task #<id>`).
- **Any other harness** — `POST /v1/decisions`, alias `POST /v1/systemone` (TypeSafe's path; model-API auth and per-IP rate limit; fails closed). Body `{ model?, state, questions }`; response `{ model, answers, usage?: { input_tokens, output_tokens, cost }, provider, latency_ms }`. Drop-in for `langchain-typesafe` (Python and JS): `TYPESAFE_BASE_URL=http://<marina>:3300`, `TYPESAFE_API_KEY=<MODEL_API_KEYS token>` — verified against the published `@langchain/typesafe` client with a Jev backend and a chat-classifier backend. The backend model is operator configuration: a caller may name it or its family's `-latest` alias (`jev-latest`, the TypeSafe clients' default); any other `model` gets `400 unsupported_parameter` rather than a silent answer from a different model — with a chat-classifier backend, set the client's `model` to the configured id. `MARINA_DECISIONS` off gets `404 decisions_disabled`.
- **Observability** — every agent decision emits an `agent_decision` engine event (stage, verdict, subject = tool name, reason, the numbers, backend model, latency, cost, error). Arguments are never in the event.

## Invariants

- Deterministic checks first: safety gates, `mediateToolCall`, exec approval and path confinement run in code; decisions only cover judgement calls code cannot make. A decision can only further restrict, never widen, what the deterministic layer allows.
- Off by default; env-only; nothing in-world can enable it or change the backend.
- Scores are advisory until measured: tune thresholds from recorded `agent_decision` events and benchmark A/B runs, not by intuition.

## Status

Spike (2026-09-24): wire format, both backends, the three policies, the pi tool gate, `/v1/decisions`, events and readiness. Spawn-time routing, the task-submission verifier and owner approvals for `ask` followed. Not yet wired: dashboard views of `agent_decision`.
