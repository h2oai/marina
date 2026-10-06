# τ²-bench with Marina

[τ²-bench](https://github.com/sierra-research/tau2-bench) (MIT) evaluates customer-service agents. An agent follows a domain policy, calls tools against a simulated database and talks with an LLM-simulated user. Its official evaluator scores the final database state and the required communication.

Marina runs τ²-bench **unmodified**: τ²'s own CLI, agent scaffold, user simulator and evaluator. Its agent and user models are pointed at a Marina `/v1`, so every model call goes through Marina's passthru, spend ledger and traces. A thin adapter turns the official `results.json` into a [benchmark ledger](commands.md) run.

## Run

1. Start a Marina server. Any world works; the model API needs `MODEL_API_KEYS`, or `MARINA_OPEN_API=true` for local development.
2. Install τ²-bench as its README describes (`uv sync`). It needs Python 3.12; 3.13 removed `audioop`, which τ² imports.
3. Point both models at Marina through LiteLLM's OpenAI provider:

   ```bash
   ARGS='{"api_base":"http://localhost:3300/v1","api_key":"<marina key>"}'
   tau2 run --domain airline \
     --agent-llm openai/openrouter/openai/gpt-6.1-sol --agent-llm-args "$ARGS" \
     --user-llm  openai/openrouter/openai/gpt-5.2    --user-llm-args  "$ARGS" \
     --num-trials 4 --save-to my-run
   ```

   The model after `openai/` is any id Marina serves. That includes an explicit upstream id, a `marina:<crew>` endpoint, or `marina/verify:…` (see below).

## Match the leaderboard's settings

Results are only comparable to the board when the run matches its settings. Three of them are easy to get wrong, and all three fail silently.

1. **Agent reasoning effort.** Board entries run the agent at `high` (or `xhigh`) reasoning. τ² sets LiteLLM's `drop_params = True`, and LiteLLM drops `reasoning_effort` for any model id it doesn't recognise as a reasoning model, without a warning. That includes every id routed through Marina. Pass it in `extra_body`, which LiteLLM always forwards:

   ```bash
   AGENT_ARGS='{"api_base":"http://localhost:3300/v1","api_key":"<marina key>","extra_body":{"reasoning_effort":"high"}}'
   ```

   Marina's passthru forwards `reasoning_effort` unchanged.
2. **User simulator.** The board uses `gpt-5.2` with `reasoning_effort: low`. Passing `--user-llm-args` replaces τ²'s defaults entirely, so state it: `"reasoning_effort":"low"`.
3. **Evaluator and helper models.** τ² calls some models of its own, the NL-assertion judge among them. These use their default ids with LiteLLM's environment credentials, not the `--agent-llm-args`. Without `OPENAI_API_KEY` in τ²'s environment, those tasks end as `infrastructure_error` before the conversation starts. Export the provider keys into the shell that runs `tau2`.

Also run the `base` task split (the default) for board comparisons. Named splits such as `test` are smaller subsets with their own difficulty.

**Infrastructure errors are never scores.** τ²'s metrics drop simulations that ended in `infrastructure_error`. `bun run tau2 summary` and `convert` do the same and report how many they excluded. A non-zero count means fix the cause and re-run before comparing arms. `--require-clean` turns that into a refusal: with any infrastructure error, `summary` and `convert` print `INVALID: N infrastructure error(s)`, report no scores, write no ledger file and exit 3. `bun run repro tau2` always uses it.

## The obligations ledger as a model: `marina/obligations:`

`marina/obligations:<model>` is the plain request to `<model>` with Marina's obligations ledger on (see [passthru](../architecture/passthru.md)): each new user request is read into explicit obligations, a matching successful write call settles them, the open ones ride as a trailing note after the cache breakpoints, and a final reply that would leave one owed gets one retry that quotes the draft. The model's text is never edited. `MARINA_OBLIGATIONS_MODEL` names a cheaper model for the ledger's own calls (default: the agent model). The response carries `x-marina-obligations` (counters) and `x-marina-obligations-cost-usd`. The kit's `obligations` arm uses it (`--arm single,obligations`). Like `marina/verify:`, it adds control flow, so a leaderboard entry made with it is a custom submission.

## The argument check as a model: `marina/argcheck:`

`marina/argcheck:<model>` is the plain request to `<model>` with Marina's argument check on (see [passthru](../architecture/passthru.md)): before a reply's state-changing tool call goes back to τ², its ids, amounts, dates and options are looked up in the conversation, and a call with a value the user never stated and no tool returned gets one judgement and, if unsupported, one retry that names those values. The arguments are never rewritten, and the same call issued again passes. `MARINA_ARGCHECK_MODEL` names the judge (default: `MARINA_OBLIGATIONS_MODEL`, then the agent model). The response carries `x-marina-argcheck` (counters) and `x-marina-argcheck-cost-usd`. `MARINA_ARGCHECK_TRIGGER=all-writes` lets the judge see every write call instead of only the flagged ones (default `flagged`). It combines with the ledger as `marina/obligations:marina/argcheck:<model>`. Both key their per-conversation state on `x-marina-session` when a client sends it; the τ² CLI sends no per-simulation header, so the kit relies on the derived key (system text, tool schemas and the history up to a checkpoint), which keeps two simulations with the same opening apart once their conversations diverge. The kit's opt-in arms are `argcheck` and `obligations+argcheck` (`--arm single,argcheck,obligations+argcheck`). It adds control flow, so a leaderboard entry made with it is a custom submission.

## The verification formation as a model: `marina/verify:`

`marina/verify:<proposer>[+<checker>]` is an OpenAI-compatible model id, with tool calling supported. For each request:

1. **Draft.** The proposer drafts the next message, which may be a tool call.
2. **Review.** A checker reviews the draft against the conversation: the system rules, the user's requests and earlier tool results. It answers `approve`, or `revise` with a concrete fix.
3. **Revise.** On `revise`, the proposer writes the corrected message once, with the reviewer's note as a trailing system message (`MARINA_VERIFY_ROUNDS`, default 1).

**Write actions are held.** A revision may rewrite the user-facing text and read-only lookups freely. A state-changing tool call (an order edit, a payment, a cancellation) is kept exactly as drafted unless the checker cites a concrete conflict: a verbatim excerpt from the rules, the conversation or a tool result, found in the conversation. A tool counts as read-only by its declared `annotations.readOnlyHint`, otherwise by a lookup-style name (`get_…`, `list_…`, `find_…`, `search_…`, `calculate`, `think`, …).
- **Modifying a call:** a cited conflict naming the call and one argument (e.g. `new_item_ids[0]`) allows only that argument to change.
- **Dropping or adding a call:** the cited conflict must name that call. This is how a drafted write is deferred to ask the user for a confirmation the rules require.
- **No invented ids:** a new value may not introduce an id that appears nowhere in the conversation or its tool results.

A revision that breaks any of these is discarded, the draft is returned, and the response says `held-write`.

**Fails open.** A checker outage or an unreadable verdict returns the draft.

**Checker choice.** The checker defaults to `MARINA_VERIFY_CHECKER_MODEL`, else the proposer itself.

**Response metadata.** The response carries `x-marina-verify` (`approved`, `revised`, `held-write`, `checker-unavailable`, `revision-failed` or `flagged`) and the summed `x-marina-cost-usd` and `usage` of every call.

**Lessons.** With outcome learning armed, judged `tools`/`code` lessons matching the last user turn ride as one system message after the caller's and are shown to the checker; `x-marina-lessons` names them (`0` for none, `observe:` under `MARINA_LESSONS=observe`). Set `MARINA_LESSONS=off` for a lessons-free ablation arm.

**Limits.** `stream` and `n > 1` are refused with `unsupported_parameter`.

## Into the ledger

```bash
bun run tau2 summary data/simulations/my-run/results.json    # reward, pass^1..pass^k
bun run tau2 convert data/simulations/my-run/results.json --out my-run.ledger.json
DB_PATH=marina.db bun run benchmark:import my-run.ledger.json --target-kind model \
  --target 'marina/verify:openrouter/openai/gpt-6.1-sol' --group tau2-airline-verify
```

**Items.** Each (task, trial) simulation is one item, `<task>#<trial>`. It is correct when the official reward is 1. Conversations are never copied into the ledger.

**Comparisons.** Pair runs on the same domain and seed with `benchmark compare`.

**Cost.** Prefer the target server's `spend_daily` as `--cost-usd`. LiteLLM cannot price ids it does not know.

## Leaderboard notes

τ²'s [submission guide](https://github.com/sierra-research/tau2-bench/blob/main/docs/leaderboard-submission.md) wants every text domain, ≥ 4 trials and one configuration.

**Submission type.** A single upstream model through Marina's passthru is a standard text submission. A `marina/verify:` model or a crew endpoint adds an agent and control flow, so it is a **custom** submission and must document its methodology.

**Credentials.** τ² writes `llm_args` (including `api_key`) into `results.json`. Never publish a results file that holds a real key.
