# Environment reference

<!-- Generated from config/environment.reference by scripts/generate-environment-reference.ts. Do not edit. -->

Every environment variable the Marina server and its world definitions read, generated from [`config/environment.reference`](../../config/environment.reference). Everything is optional; with no configuration a loopback `bun run start` runs the ungated `local` trust profile. For a short starter, copy [`.env.example`](../../.env.example) to `.env`.

Values are defaults or safe examples. Flags: **secret** values are never displayed; **protected** keys are never written by the dashboard (edit `.env` or the process environment); **restart** keys are read once at startup; **internal** keys are set by Marina itself or read only by a command-line client, and are hidden from Admin → Settings.

Script, test and CI knobs are in [docs/guides/testing.md](../guides/testing.md) and [docs/guides/release-qualification.md](../guides/release-qualification.md); SDK example knobs in [`src/sdk/examples/.env.example`](../../src/sdk/examples/.env.example); memory-service example knobs in [`examples/memory-service/.env.example`](../../examples/memory-service/.env.example).

## Network and ports

| Variable | Description | Flags |
|---|---|---|
| `WS_PORT=3300` | WebSocket, web chat, dashboard and HTTP API port (the OpenAI- and Ollama-compatible /v1 and /api routes are served here too). 0 picks a free port for the listener, but internal agents and benchmark runs still dial 3300, so use a real port when agents run. | restart |
| `WS_HOST=127.0.0.1` | Bind address for the WebSocket/HTTP and MCP listeners; the default is loopback only. Unless MARINA_ALLOW_INSECURE_PUBLIC=true, a non-loopback bind is fatal at startup when login is passwordless (MARINA_AUTH off, which also covers MARINA_AUTONOMY=open), when MARINA_OPEN_API=true, or under MARINA_PROFILE=local. | protected, restart |
| `MARINA_HOST=127.0.0.1` | Deprecated alias of WS_HOST (WS_HOST wins when both are set). | protected, restart |
| `MARINA_PUBLIC=false` | true binds 0.0.0.0 without naming an interface. An explicit WS_HOST wins. | protected, restart |
| `MARINA_ALLOW_INSECURE_PUBLIC=false` | Acknowledge an unauthenticated non-loopback bind (see WS_HOST). Only for a network you control; prefer MARINA_AUTH=better-auth. | protected, restart |
| `TELNET_PORT=0` | Telnet port. 0 (the default) is off. Telnet is plaintext and unauthenticated, and telnet sessions can never run host commands. | restart |
| `MCP_PORT=3301` | MCP (Model Context Protocol) port. Default WS_PORT+1 (3301 when WS_PORT is 0). 0 disables. | restart |
| `LOG_PORT=3302` | Real-time log viewer port. Default WS_PORT+2 (3302 when WS_PORT is 0). 0 disables. | restart |
| `WS_MAX_CONNECTIONS_PER_IP=100` | Maximum concurrent WebSocket connections per client IP. | restart |
| `MARINA_TRUST_PROXY=false` | Trust X-Forwarded-For when resolving the client IP for every per-IP rate limiter. Enable only behind a trusted reverse proxy. | protected |
| `NODE_ENV=production`<br>`REVERSE_PROXY=1`<br>`HTTPS_PROXY=` | When NODE_ENV=production and neither HTTPS_PROXY nor REVERSE_PROXY is set, Marina logs a hint that no TLS proxy was detected. Only presence matters. Bun's fetch also honours HTTPS_PROXY, HTTP_PROXY and NO_PROXY for outbound requests. | restart |
| `MARINA_NAME=Marina` | Human-readable instance name. Shown in the dashboard and stamped as the origin on federation and provenance records. Defaults to the world name. | restart |

## API authentication and access

| Variable | Description | Flags |
|---|---|---|
| `MODEL_API_KEYS=sk-marina-change-me` | Comma-separated bearer tokens accepted on /v1, the Ollama-compatible /api routes and MCP. Under the local profile Marina also generates a key into &lt;DB_PATH&gt;.local-api-key (mode 600) and prints it at boot, so local clients need nothing here. | secret |
| `MEM_API_KEYS=sk-agent-1:scout` | Comma-separated secret:agent pairs for the /mem REST API and /api/probe. Unset keeps /mem closed unless a key is stored in the database. | secret |
| `MARINA_KEY_SECRET=` | Encrypts provider keys stored through Admin → Keys (AES-256-GCM, 16+ characters; generate with `openssl rand -base64 32`). Without it stored keys are plaintext in the database. Changing or losing it orphans stored keys, which must then be re-entered. Environment provider keys are never stored. | secret, protected, restart |
| `MARINA_OPEN_API=false` | Development only: accept unauthenticated requests on the model, memory and dashboard read APIs. It does not grant operator actions: key and settings management, spawning and deletion still need an operator, and writes are refused outside the local profile. Fatal with a non-loopback bind unless MARINA_ALLOW_INSECURE_PUBLIC=true. | protected |
| `ALLOWED_ORIGINS=http://localhost:5173` | Comma-separated origins allowed for CORS. Unset sends no Access-Control-Allow-Origin header (same-origin only). |  |
| `MARINA_DASHBOARD_CSP=` | Content-Security-Policy for the dashboard HTML. Unset uses the built-in policy; `off` drops the header; any other value replaces the policy verbatim. | protected |

## Sign-in (better-auth)

| Variable | Description | Flags |
|---|---|---|
| `MARINA_AUTH=better-auth` | `better-auth` requires human sign-in on the web chat and dashboard (email/password plus any configured OAuth providers) and rejects passwordless name login. A signed-in identity is bridged to a named Marina entity. Agents keep authenticating with session tokens. Off by default. | protected, restart |
| `BETTER_AUTH_SECRET=` | Required with MARINA_AUTH=better-auth: 32+ characters (generate with `openssl rand -base64 32`; `bun run init --preset shared-team` writes one). | secret, protected, restart |
| `BETTER_AUTH_URL=https://marina.example.com` | Public base URL of this instance, used in auth callbacks. Default http://localhost:&lt;WS_PORT&gt;. | restart |
| `BETTER_AUTH_DB_PATH=marina-auth.db` | SQLite file for the auth tables, kept separate from the world database. | restart |
| `MARINA_AUTH_ADMIN_EMAILS=you@example.com` | Comma-separated verified email addresses promoted to admin when sign-in is on. Replaces MARINA_ADMINS under MARINA_AUTH. | protected |
| `GOOGLE_CLIENT_ID=` | OAuth sign-in providers. Set both the id and the secret to enable each one. | restart |
| `GOOGLE_CLIENT_SECRET=` | OAuth sign-in providers. Set both the id and the secret to enable each one. | secret, restart |
| `GITHUB_CLIENT_ID=` | OAuth sign-in providers. Set both the id and the secret to enable each one. | restart |
| `GITHUB_CLIENT_SECRET=` | OAuth sign-in providers. Set both the id and the secret to enable each one. | secret, restart |
| `MICROSOFT_CLIENT_ID=` | OAuth sign-in providers. Set both the id and the secret to enable each one. | restart |
| `MICROSOFT_CLIENT_SECRET=` | OAuth sign-in providers. Set both the id and the secret to enable each one. | secret, restart |

## Trust profile, autonomy and admins

| Variable | Description | Flags |
|---|---|---|
| `MARINA_PROFILE=local` | Who this Marina is for. Derived when unset: `local` when every listener binds loopback and MARINA_AUTH is off, `shared` when MARINA_AUTH=better-auth, `public` for any non-loopback bind. `local` is ungated: all safety gates pass, loopback logins are sovereign, rate limits, login caps and memory admission budgets are off, and database durability defaults to `normal`; audit (exec decisions, cognitive ledger, memory receipts, trust labels) stays on. `shared` enforces gates, ranks and limits with sign-in identifying people; `public` enforces everything. `local` with a non-loopback bind is fatal unless MARINA_ALLOW_INSECURE_PUBLIC=true. | protected, restart |
| `MARINA_AUTONOMY=guarded` | Autonomy posture, env-only by design. `guarded`: supervised gate attempts need a witness window. `earned`: agents with enough standing run supervised operations and a witness attests afterwards. `open`: every gate passes except the destructive core (key.manage, admin.destructive, shell.exec, code.exec.unrestricted, world.code); `open` does pass code.exec. Unset means `guarded`, except under the local profile, where unset is ungated and only an explicit `guarded` brings the gates back. `open` with a non-loopback bind and passwordless login is fatal. | protected, restart |
| `MARINA_ADMINS=YourName` | Comma-separated entity names promoted to sovereign on login, honoured only for loopback or in-process connections and ignored under MARINA_AUTH. Redundant under the local profile, where loopback logins are already sovereign. | protected |
| `MARINA_MAX_LOGINS=0` | Instance-wide cap on concurrent entity logins. 0 is unlimited. Internal room and crew agents are exempt (MAX_AGENTS caps them). Not enforced under the local profile. |  |
| `MARINA_LOGIN_ATTEMPTS_PER_MIN=10` | Login and reconnect attempts per minute per client IP (MCP sessions share their peer's bucket). 0 disables. | restart |
| `MARINA_SESSION_MAX_AGE_MS=604800000` | Absolute lifetime of a session token in milliseconds (default 7 days). Activity refreshes the 24-hour idle window only up to this cap; a reconnect mints a new session. |  |

## Challenges and agent lineage

| Variable | Description | Flags |
|---|---|---|
| `MARINA_CHALLENGES=on` | When a caller is refused by a rank floor or safety gate, Marina asks its creator and the admins with a token instead of only refusing; `challenge approve <token> [once\|always]` re-runs the held command. `off` restores plain refusals. |  |
| `MARINA_CHALLENGE_TTL_MS=3600000` | How long an unanswered challenge stays open, in milliseconds. |  |
| `MARINA_CHALLENGE_JUDGE=off` | Challenge judge (needs a MARINA_DECISIONS backend). `observe` scores held commands in shadow. `on` also auto-approves `once` for a gate only after it earned that gate (25+ approved calls at 85% or better, 95% lower bound), never for the core gates, never `always`, never a deny. `challenge stats` shows the record. | protected |
| `MARINA_MAX_SPAWN_DEPTH=3` | Deepest spawn lineage an agent may extend (lead → sub-lead → specialist). |  |
| `MARINA_STANDING_PER_SPAWNED_CHILD=25` | Standing per concurrent child an earned spawner may keep alive (budget = floor(standing / this), capped by MAX_AGENTS). |  |
| `MARINA_MAX_REPLICAS_PER_RUN=5` | Total copies `evolve replicate` may seed from one accepted run. |  |
| `MARINA_EVOLVE_TRIALS=` | `here` lets a dedicated parallel world run `evolve trial` itself. Trials otherwise run only in a World Collective child. Never set it on a world you care about. | protected |
| `STANDING_HALF_LIFE_DAYS=60` | Standing decay half-life in days (minimum 1). Shorter means rank derived from standing demotes faster. | restart |

## World

| Variable | Description | Flags |
|---|---|---|
| `MARINA_WORLD=default` | World definition to load: the file name of any module in worlds/ (default, showcase, commons, research, evolve, empty, …). | restart |
| `START_ROOM=` | Room where new players spawn. Defaults to the world's start room. | restart |
| `TICK_MS=1000` | Engine tick interval in milliseconds. | restart |
| `MARINA_COMMAND_PHASE_BUDGET_MS=150` | Wall-clock budget for the per-tick command phase, in milliseconds. | restart |
| `MARINA_ROOM_AGENTS=true` | `false` suppresses every room-agent auto-spawn (the LLM agents rooms start on first entry). Any other value leaves it on. Room agents need a provider key. |  |
| `MARINA_WORKBENCH_MODEL=openai/gpt-6-luna` | Model for the default Workbench's Host, Builder, Critic and Chronicler. Unset tries MARINA_CREW_MODEL, then openai/gpt-6-luna (OPENAI_API_KEY), openrouter/openai/gpt-6-luna (OPENROUTER_API_KEY), huggingface/zai-org/GLM-5.3-Flash (HUGGINGFACE_API_KEY or HF_TOKEN), then marina/default. | restart |
| `MARINA_CREW_MODEL=marina/default` | Shared crew-model override for the Workbench, Showcase and focused single-outcome worlds. | restart |
| `MARINA_ANSWERER_COUNT=4`<br>`MARINA_ANSWERER_MODEL=`<br>`MARINA_MATH_MODEL=`<br>`MARINA_REFLECTOR_MODEL=` | Showcase world only: size of the answerer crew and per-crew model overrides (each falls back to MARINA_CREW_MODEL). | restart |
| `MARINA_ENDPOINTS=council,debate,decompose` | Showcase world only: which autonomous coordinators to seed beyond marina:answerer (comma list of council, debate, decompose; empty or `none` seeds none). Unset seeds all three. Each is a loop that spends tokens even when its endpoint is never called. | restart |
| `MARINA_SEED_SKILLS=false` | Showcase world only: `true` seeds the universal skill packages. | restart |
| `MARINA_MODEL_FAST_PATH=true` | `false` disables the verified-arithmetic fast path on marina:answerer (simple arithmetic otherwise returns without a crew round). |  |
| `MARINA_ASK_MODEL=true` | `false` turns off model synthesis in `ask` and `dig` (retrieval only) and the model interpretation pass in `desire`. Any other value keeps them on. |  |
| `MARINA_EVOLUTION_PROTOCOLS=false` | `true` enables native evolution protocols: passive experiment lineage and evidence analysis over the experiment command. Nothing is auto-run or auto-promoted. |  |
| `MARINA_UNIFIED_CANVAS=false` | `true` makes the retired Unified Canvas (ReactFlow world graph) reachable at /?unified. |  |

## Storage

| Variable | Description | Flags |
|---|---|---|
| `DB_PATH=marina.db` | SQLite world database path. | restart |
| `MARINA_DB_DURABILITY=full` | World database durability: `full` (fsync per commit) or `normal` (WAL, crash-safe, small power-loss window). Default `normal` under the local profile, `full` otherwise. | restart |
| `ASSETS_DIR=data/assets` | Directory for uploaded assets. | restart |

## Model provider keys

| Variable | Description | Flags |
|---|---|---|
| `ANTHROPIC_API_KEY=` | Anthropic API key. Set one provider key for agents that think; OPENROUTER_API_KEY is the most versatile because `forecast` and the arena research path also need it. Environment keys and keys added in Admin → Keys both work on every path; the environment wins and survives database resets. | secret |
| `OPENAI_API_KEY=` | OpenAI API key. | secret |
| `GEMINI_API_KEY=`<br>`GOOGLE_API_KEY=` | Google Gemini API key (GOOGLE_API_KEY is accepted as an alias). | secret |
| `GROQ_API_KEY=` | Groq API key. | secret |
| `OPENROUTER_API_KEY=` | OpenRouter API key. Also required by the `forecast` command and POST /v1/forecast. | secret |
| `HUGGINGFACE_API_KEY=`<br>`HF_TOKEN=` | Hugging Face Inference Providers key (router.huggingface.co). Address models as `huggingface/<org>/<model>`, optionally suffixed `:fastest`, `:cheapest` or `:<provider>`. HF_TOKEN is accepted as well. | secret |
| `CEREBRAS_API_KEY=`<br>`XAI_API_KEY=`<br>`MISTRAL_API_KEY=`<br>`DEEPSEEK_API_KEY=` | Providers usable only by agents spawned on an explicit `<provider>/<model>`. They are not upstreams for marina/default, so a world keyed with only one of these has agents on marina/default fail with 503. | secret |

## Local model runtimes

| Variable | Description | Flags |
|---|---|---|
| `LLAMA_BASE_URL=http://localhost:8080/v1` | llama.cpp server (OpenAI-compatible). Setting the base URL or the key opts in; llama is then the first marina/default fallback. Address models as `llama/<id>`. The key is only needed when the server runs with --api-key. | restart |
| `LLAMA_API_KEY=` | llama.cpp server (OpenAI-compatible). Setting the base URL or the key opts in; llama is then the first marina/default fallback. Address models as `llama/<id>`. The key is only needed when the server runs with --api-key. | secret, restart |
| `OLLAMA_BASE_URL=http://localhost:11434/v1` | Ollama (OpenAI-compatible, usually keyless). Setting the base URL or the key opts in as a marina/default fallback after llama. Address models as `ollama/<id>`. | restart |
| `OLLAMA_API_KEY=` | Ollama (OpenAI-compatible, usually keyless). Setting the base URL or the key opts in as a marina/default fallback after llama. Address models as `ollama/<id>`. | secret, restart |
| `VIBETHINKER_BASE_URL=http://localhost:8000/v1` | VibeThinker served by vLLM or SGLang. Usable only as an explicit `vibethinker/<id>` model, never as a marina/default fallback. In Docker it is the optional `vibethinker` compose profile, whose own VIBETHINKER_MODEL, VIBETHINKER_CTX and VIBETHINKER_MODELS_DIR are read by docker-compose.yml, not by Marina. | restart |
| `VIBETHINKER_API_KEY=` | VibeThinker served by vLLM or SGLang. Usable only as an explicit `vibethinker/<id>` model, never as a marina/default fallback. In Docker it is the optional `vibethinker` compose profile, whose own VIBETHINKER_MODEL, VIBETHINKER_CTX and VIBETHINKER_MODELS_DIR are read by docker-compose.yml, not by Marina. | secret, restart |
| `LLAMA_CONTEXT_WINDOW=16384`<br>`OLLAMA_CONTEXT_WINDOW=8192`<br>`VIBETHINKER_CONTEXT_WINDOW=` | Pin the context window (tokens) the agent compactor budgets against. Normally autodetected at launch (llama.cpp /props, Ollama /api/show); these win over the probe. Without either, llama uses 16384, Ollama 8192 and VibeThinker 40960. | restart |
| `MARINA_DEFAULT_CONTEXT_WINDOW=128000` | Context window assumed for marina/default. Set it when marina/default proxies to a small local model, or requests overflow it. |  |
| `MARINA_LOCAL_OUTPUT_FRACTION=0.25` | Share of a local model's context window reserved for output (0 &lt; f ≤ 0.5; higher values are clamped). It scales with the configured window, so pin a real window above for large local servers. |  |
| `MARINA_LOCAL_MAX_OUTPUT_TOKENS=32768` | Optional hard cap in tokens on local-model output. Unset applies the fraction alone. |  |
| `MARINA_TOKEN_CHARS_PER_TOKEN=3` | Characters per token in the compactor's prompt-size estimate. Lower compacts earlier; raising it risks oversized prompts the upstream rejects. |  |
| `MARINA_MAX_TOOL_RESULT_TOKENS=2000` | Tool-result text block cap. Unset: max(2000, 15% of the effective prompt window), recalculated after model changes and overflow recovery. A positive integer sets a fixed cap. Truncation is labeled; originals are archived before compaction. Prefer narrower retrievals when a result exceeds the cap. |  |

## Default and fallback models

| Variable | Description | Flags |
|---|---|---|
| `MARINA_DEFAULT_MODEL=marina/default` | Model for agents spawned without one, and the fallback for unrecognized models. marina/default calls this instance's own /v1, which routes to whichever provider has a key. A default model set at runtime (dashboard or `admin`) wins. |  |
| `MARINA_DEFAULT_ANTHROPIC_MODEL=claude-sonnet-5`<br>`MARINA_DEFAULT_OPENAI_MODEL=gpt-6-luna`<br>`MARINA_DEFAULT_GEMINI_MODEL=gemini-3.1-flash-lite`<br>`MARINA_DEFAULT_OPENROUTER_MODEL=openai/gpt-6-luna`<br>`MARINA_DEFAULT_GROQ_MODEL=openai/gpt-oss-120b`<br>`MARINA_DEFAULT_HUGGINGFACE_MODEL=zai-org/GLM-5.3-Flash`<br>`MARINA_DEFAULT_LLAMA_MODEL=local-model`<br>`MARINA_DEFAULT_OLLAMA_MODEL=llama3` | Model /v1 uses on each provider when it proxies directly upstream (no model agent is online for the requested channel). The variable name is MARINA_DEFAULT_&lt;PROVIDER&gt;_MODEL. |  |
| `MODEL_REQUEST_TIMEOUT_MS=600000` | Upstream timeout for /v1 requests in milliseconds. Non-streaming client connections also close at Bun's 255-second idle limit. |  |
| `MODEL_REQUEST_REMINDERS=1` | `0` stops re-posting an unanswered routed model_request as a reminder at 25% and 60% of the timeout. |  |
| `MARINA_DEFAULT_MAX_TOKENS=4096` | Output-token cap marina/default sends upstream per completion (also the compactor's output reservation). Extended thinking on this path is clamped to this value minus 1024. |  |

## Agent runtime

| Variable | Description | Flags |
|---|---|---|
| `AGENT_AUTORESPAWN=false` | `true` restarts saved agents at boot, including world-seeded ones such as the Workbench population and the Chronicler. Otherwise start them with `agent spawn`. `readiness` shows what is live. | restart |
| `MAX_AGENTS=30` | Maximum concurrently running agents. | restart |
| `MAX_AGENT_UPTIME_MS=86400000` | Maximum agent uptime in milliseconds before the runtime stops it (default 24 hours). | restart |
| `MARINA_DISABLED_AGENTS=` | Comma-separated agent names that seeders, autorespawn and room-agent spawning must not bring back. `agent disable <name>` does the same in-world and persists. |  |
| `MARINA_TASK_LEASE_MS=900000` | Renewable lease on a newly claimed task, in milliseconds. Workers renew with `task heartbeat <id>`; expired ordinary work reopens. |  |
| `AGENT_CREW_MAX_TOKENS=2048` | Output-token cap for request-driven (crew) agents. Unset: 2048 with thinking off; with thinking enabled, pi-ai's thinking budget + 2048 answer/tool tokens, bounded by the provider output limit and half the context window. An explicit insufficient cap is honored with a warning; reasoning depth may be reduced. |  |
| `AGENT_COMPACT_MAX_TOKENS=4096` | Output-token cap for cloud agents using the compact tool profile. Unset: 4096 with thinking off; with thinking enabled, pi-ai's thinking budget + 2048 answer/tool tokens, bounded by the provider output limit and half the context window. An explicit insufficient cap is honored with a warning. |  |
| `AGENT_MAX_TOOL_CALLS_PER_RUN=16` | Tool calls one agent run may make before it yields. Unset: 8 for crew responders, 16 for autonomous agents. A value applies to both. |  |
| `MARINA_MAX_TURNS_PER_PROMPT=24` | Model calls one prompt may take before the loop yields to the next cycle. |  |
| `MARINA_CHANNEL_SENDS_PER_RUN=3` | Ceiling on public channel sends per agent run. Each agent's own budget defaults to 1 and may be set up to this ceiling with `memory set channel_sends <n>`; 0 disables agent channel sends. Tells are never capped. |  |
| `AGENT_IDLE_TICK_MS=60000`<br>`AGENT_ACTIVE_TICK_MS=15000` | Quiet-cycle and active-cycle intervals for autonomous agents, in milliseconds. Defaults: idle max(60000, 5 × cycle delay); active max(15000, cycle delay). |  |
| `AGENT_CHANNEL_REPLY_COOLDOWN_MS=30000` | Minimum gap between an agent's replies on one channel, in milliseconds. |  |
| `MARINA_AGENT_THINKING=off` | Default extended-thinking level for spawned agents: off, minimal, low, medium, high or xhigh. `agent spawn … thinking:<level>` wins; crew responders stay off unless set explicitly. |  |
| `MARINA_TOOL_EXECUTION=auto` | Multi-tool turn execution. `auto` runs batches containing a world-mutating tool in order and fans read-only batches out; `parallel` and `sequential` apply to every batch. |  |
| `MARINA_DEFERRED_TOOLS=on` | `off` keeps every typed tool schema resident in the `full` tool profile. On by default: the core set is resident and other tools load by name through `marina_tool_search`. |  |
| `MARINA_AGENT_PROMPT_CACHE=on` | `off` stops agents' marina/* requests carrying prompt-cache markers and a per-agent session id. On by default; Marina's proxy strips the markers for upstreams that reject them. |  |
| `MARINA_STRICT_TOOLS=on` | `off` sends tools without `strict: true`. On by default for closed, all-required schemas; upstreams that do not implement strict mode ignore it. |  |
| `MARINA_SYSTEM_TOOLS_PROSE=on` | `off` omits the tools prose section from the lean agent system prompt. |  |
| `MARINA_CONTINUATION_BUDGET_BYTES=6000` | Byte allowance for per-cycle context. Unset: effective prompt tokens / 8, clamped to 6000–16000 bytes. Automatic memory gets 2048–4096 content bytes. A fixed override has a minimum of 1000; mandatory sections can exceed it. Optional sections are deferred and remain eligible on the next scheduled cycle. |  |
| `MARINA_PERCEPTION_MODEL_REQUEST_MAX_CHARS=2000` | Clamp in characters for a model_request perception line (minimum 400). Its content is the caller's question. Other addressed requests and JSON results get 1200 chars; ambient chatter gets 400. |  |
| `MARINA_PROVIDER_MAX_RETRIES=2` | Provider-level retries inside one request (transient 5xx, short 429) before the loop's own backoff. 0 disables. |  |
| `MARINA_PERCEIVE_SELF_ECHO=off` | `on` keeps an agent's own command echoes (memory-service acknowledgements, its `You tell …` receipts) in its world-event buffer. Off by default; messages from others are never filtered. |  |
| `MARINA_REFLECTOR_IDLE_STOP_MS=600000` | Stop a `reflect`-spawned memory reflector after this many idle milliseconds with no assistance job. 0 disables. |  |
| `MARINA_COGNITIVE_PROVENANCE=false` | `true` records full, payload-bearing cognitive provenance. Off by default. |  |

## Spend limits and failure breaker

| Variable | Description | Flags |
|---|---|---|
| `MARINA_DAILY_SPEND_CAP_USD=10` | Daily USD cap (UTC day, persisted) on everything this world pays upstream: /v1 passthru, agent turns, decision backends and forecasts. At the cap /v1 returns 429 spend_cap_reached, decisions and forecasts are refused and agents pause until 00:00 UTC. Unset or 0 is no cap. Media generation is not counted. `readiness` shows the state. | protected |
| `MARINA_CHILD_DAILY_SPEND_CAP_USD=50` | Daily cap a World Collective child world starts with. | protected |
| `MARINA_MAX_COST_USD_PER_HOUR=5`<br>`MARINA_MAX_AGENT_COST_USD_PER_HOUR=1` | Rolling one-hour USD caps on agent model spend, across all agents and per agent. Unset or 0 is unlimited. At a cap the agent pauses, tells its spawner, and resumes once last-hour spend drops. Local models count as $0. | protected |
| `MARINA_MAX_CONSECUTIVE_UPSTREAM_ERRORS=20`<br>`MARINA_UPSTREAM_ERROR_PAUSE_MS=600000` | Consecutive upstream or loop errors (429, 5xx, timeouts) before an agent pauses for MARINA_UPSTREAM_ERROR_PAUSE_MS milliseconds and tells its spawner once. |  |

## Code Mode

| Variable | Description | Flags |
|---|---|---|
| `MARINA_CODE_ROOTS=/workspaces/project-a` | Comma-separated directories `code` sessions may operate in. With neither this nor MARINA_CODE_DEFAULT_ROOT set, the working directory is a read-only root and host edits and command execution are refused. `marina .` sets this for the folder it opens. | restart |
| `MARINA_CODE_DEFAULT_ROOT=` | Default root for new sessions (must be inside MARINA_CODE_ROOTS). Defaults to the first root; set alone it also enables host execution in that directory. | restart |
| `MARINA_CODE_EXEC_UNRESTRICTED=` | Comma-separated entity ids or names eligible for headless approval of arbitrary (non-allowlisted) host commands. Each also needs the code.exec.unrestricted gate unsupervised and a trusted identity on the acting connection (signed in, or loopback). Interactive approval (`code exec-mode prompt`) does not use this list. | protected |
| `MARINA_CODE_EXEC_APPROVAL_TIMEOUT_MS=120000` | Interactive exec-approval prompt timeout in milliseconds. |  |

## Flywheel sandboxes

| Variable | Description | Flags |
|---|---|---|
| `FLYWHEEL_TOKEN=` | Flywheel isolated execution: the operator token (kept server-side; Marina mints short-lived per-entity capabilities), RPC endpoint and guest image. Unset token disables Flywheel. | secret, restart |
| `FLYWHEEL_RPC_URL=http://localhost:8088/rpc`<br>`FLYWHEEL_IMAGE=localhost/h2oai/flywheel-agentd:latest` | Flywheel isolated execution: the operator token (kept server-side; Marina mints short-lived per-entity capabilities), RPC endpoint and guest image. Unset token disables Flywheel. | restart |
| `MARINA_FLYWHEEL_PUBLICATION_TTL_MS=3600000` | Public-service lease in milliseconds (values under 60000 are ignored). |  |
| `MARINA_FLYWHEEL_MAX_SANDBOXES=100`<br>`MARINA_FLYWHEEL_MAX_RUNNING_SANDBOXES=50`<br>`MARINA_FLYWHEEL_IDLE_HIBERNATE_MS=3600000`<br>`MARINA_FLYWHEEL_ABSOLUTE_LIFETIME_MS=86400000`<br>`MARINA_FLYWHEEL_TELEMETRY_RETENTION_MS=604800000` | Fleet admission and lifecycle limits (counts 1–10000; durations at least 60000 ms). Flywheel sizes CPU, RAM and disk itself. |  |

## Media generation

| Variable | Description | Flags |
|---|---|---|
| `STABILITY_API_KEY=`<br>`BFL_API_KEY=` | Image and video provider keys (OpenAI and Google reuse OPENAI_API_KEY and GEMINI_API_KEY). Stability, Black Forest Labs (Flux, with an optional base URL), Runway and Luma. See docs/guides/media.md for model ids. | secret |
| `BFL_BASE_URL=` | Image and video provider keys (OpenAI and Google reuse OPENAI_API_KEY and GEMINI_API_KEY). Stability, Black Forest Labs (Flux, with an optional base URL), Runway and Luma. See docs/guides/media.md for model ids. |  |
| `RUNWAY_API_KEY=`<br>`LUMA_API_KEY=` | Image and video provider keys (OpenAI and Google reuse OPENAI_API_KEY and GEMINI_API_KEY). Stability, Black Forest Labs (Flux, with an optional base URL), Runway and Luma. See docs/guides/media.md for model ids. | secret |
| `A1111_BASE_URL=http://localhost:7860` | Automatic1111 or SD.Next web UI for `automatic1111/<checkpoint>` images (AUTOMATIC1111_BASE_URL is accepted as an alias). Keyless unless the server requires one. |  |
| `A1111_API_KEY=` | Automatic1111 or SD.Next web UI for `automatic1111/<checkpoint>` images (AUTOMATIC1111_BASE_URL is accepted as an alias). Keyless unless the server requires one. | secret |
| `TOGETHER_IMAGE_BASE_URL=https://api.together.xyz/v1` | Any OpenAI-compatible image server: set &lt;PROVIDER&gt;_IMAGE_BASE_URL and &lt;PROVIDER&gt;_API_KEY, then use `<provider>/<model>`. Together is shown as an example. |  |
| `TOGETHER_API_KEY=` | Any OpenAI-compatible image server: set &lt;PROVIDER&gt;_IMAGE_BASE_URL and &lt;PROVIDER&gt;_API_KEY, then use `<provider>/<model>`. Together is shown as an example. | secret |
| `MAX_IMAGE_JOBS_PER_DAY=0`<br>`MAX_VIDEO_JOBS_PER_DAY=0` | Daily image and video jobs per entity. 0 is unlimited. |  |

## Search

| Variable | Description | Flags |
|---|---|---|
| `TAVILY_API_KEY=` | Web search upgrades. Search works with no key (DuckDuckGo plus arXiv, PubMed and Semantic Scholar); Tavily or a self-hosted SearXNG improves results. Forecast and arena retrieval use OpenRouter web search instead. | secret, restart |
| `SEARXNG_URL=http://localhost:8080` | Web search upgrades. Search works with no key (DuckDuckGo plus arXiv, PubMed and Semantic Scholar); Tavily or a self-hosted SearXNG improves results. Forecast and arena retrieval use OpenRouter web search instead. | restart |

## Chat adapters

| Variable | Description | Flags |
|---|---|---|
| `TELEGRAM_TOKEN=` | Telegram bot token (from @BotFather). Unset leaves the adapter off. | secret |
| `DISCORD_TOKEN=` | Discord bot token. Unset leaves the adapter off. | secret |
| `DISCORD_CHANNEL_IDS=` | Comma-separated Discord channel ids the bot operates in. Empty means every channel the bot can read. |  |

## Federation

| Variable | Description | Flags |
|---|---|---|
| `GATEWAY_SECRET=` | Shared secret for the gateway handshake: outgoing gateway connections send it and incoming ones must present it before logging in, or the socket closes. It does not fence bridged-channel participation or cross-instance tells; a hard boundary also needs MARINA_AUTH=better-auth. Unset allows any peer. | secret, protected |
| `MARINA_MAX_RELAY_HOPS=3` | Drop a bridged channel message or tell that has already crossed this many instances. |  |
| `MARINA_FEDERATION_SIGNING_KEY=` | Ed25519 federation identity (base64 PKCS#8 DER, or PEM with escaped newlines). Set to publish signed v2 manifests; unset publishes unsigned v1. | secret, restart |
| `MARINA_FEDERATION_ALLOW_UNSIGNED=false` | `true` accepts unsigned cross-world mesh events on `mesh replicate`, whose origin cannot be verified. Only between development instances on a trusted network. | protected |

## Harness decisions

| Variable | Description | Flags |
|---|---|---|
| `MARINA_DECISIONS=off` | Decision backend for cheap per-step judgements (off by default; it receives tool names and redacted arguments). `decisions-api` (alias `jev`): a Jev-family model over the Decisions API on OpenRouter, or a self-hosted OpenJev. `typesafe`: TypeSafe's API. `chat-classifier` (aliases `classifier`, `llm`): any chat model, which then requires MARINA_DECISION_MODEL. Every MARINA_DECISION* setting except base URLs, paths and API keys can also be changed at runtime (`admin decisions set …`, Admin → Ops → Decisions); a value set here wins and locks it. |  |
| `MARINA_DECISION_MODEL=typesafe/jev-1.13` | Backend model. Defaults: typesafe/jev-1.13 for decisions-api, jev-latest for typesafe; chat-classifier has no default and stays off without one. |  |
| `MARINA_DECISION_BASE_URL=https://openrouter.ai/api/alpha` | Backend endpoint. Defaults: https://openrouter.ai/api/alpha (decisions-api), https://api.typesafe.ai (typesafe), https://openrouter.ai/api/v1 (chat-classifier). | protected |
| `MARINA_DECISION_API_KEY=` | Backend key. Unset falls back by host: OPENROUTER_API_KEY for openrouter.ai, TYPESAFE_API_KEY for api.typesafe.ai, HUGGINGFACE_API_KEY or HF_TOKEN for router.huggingface.co. | secret, protected |
| `MARINA_DECISION_PATH=/decisions` | Decisions API path (typesafe uses /v1/systemone). | protected |
| `TYPESAFE_API_KEY=` | TypeSafe API key, used by the typesafe backend. | secret |
| `MARINA_DECISION_TIMEOUT_MS=2000` | Backend timeout in milliseconds (default 2000; 8000 for chat-classifier). |  |
| `MARINA_DECISION_ENGINES=` | Chat models served as Jev-compatible engines on /v1/systemone as `marina/classifier:<model>`, through Marina's own passthru and spend ledger. Comma list, or `*` for any model Marina routes. Works with or without MARINA_DECISIONS. GET /v1/decisions/models lists them. |  |
| `MARINA_DECISION_METHOD=` | How chat classifiers get probabilities: auto, logprobs, sampled or verbalized. Unset: engines use auto and a chat-classifier backend stays verbalized. |  |
| `MARINA_DECISION_SAMPLES=5` | Calls per decision for the sampled method (clamped 2–15). |  |
| `MARINA_DECISION_ENSEMBLE=` | Members of the `marina/ensemble` engine, which asks them in parallel and needs a strict majority to answer. `marina/auto` asks the backend first and consults the ensemble (else the first engine) only when unsure or down. Classifier members must be admitted by MARINA_DECISION_ENGINES. |  |
| `MARINA_DECISION_CALIBRATION=` | Earned gate calibration file written by `bun run qualify:decisions -- --calibrate <file>`. Applied only to a backend whose fit was earned; a missing, invalid or group/world-writable file changes nothing. |  |
| `MARINA_DECISION_ENGINE=` | Run Marina's own harness (tool gate, spawn routing, task verifier, `decision` commands) on an engine such as marina/auto instead of the configured backend. Unresolvable falls back to the backend with a readiness warning. |  |
| `MARINA_DECISION_GATE_QUESTIONS=` | Adopted gate-question wording file written by `bun run qualify:decisions -- --adopt <file>`. Refused unless the variant earned a held-out win. |  |
| `MARINA_DECISION_GATE=off` | `on` scores mutating agent tool calls before they run (fail-closed; reads and messages are never sent). Needs a backend. |  |
| `MARINA_DECISION_GATE_CONTEXT=on` | With the gate on, also send the agent's operator-set intent and the trust labels of its prompt inputs (never the content). `off` sends the call only. |  |
| `MARINA_DECISION_APPROVAL_TIMEOUT_MS=3600000` | How long an ask-a-person verdict's challenge stays open, in milliseconds. Defaults to MARINA_CHALLENGE_TTL_MS. |  |
| `MARINA_DECISION_VERIFY=off` | Verify `task submit` deliverables: `on` bounces a weak first attempt once (advisory; the creator still approves); `observe` records the judge's opinion without acting. Needs a backend. |  |

## Model routing

| Variable | Description | Flags |
|---|---|---|
| `MARINA_ROUTE_FAST_MODEL=openai/gpt-6-luna`<br>`MARINA_ROUTE_POWERFUL_MODEL=anthropic/claude-opus-5-5` | Tiers for `agent spawn <name> model:route goal:<…>`, chosen once at spawn and persisted. With neither tiers nor MARINA_ROUTES set, model:route refuses the spawn; with tiers but no backend or goal, the powerful tier is used. |  |
| `MARINA_ROUTES={"cheap":{"model":"openai/gpt-6-luna","criteria":"Lookups and small edits."},"powerful":{"model":"anthropic/claude-opus-5-5","criteria":"Architecture and unclear failures."}}`<br>`MARINA_ROUTE_INSTRUCTIONS=Choose the least costly model that can complete the task.`<br>`MARINA_ROUTE_FALLBACK=powerful` | Route table (JSON object of name → {model, criteria}); wins over the two tiers. Low confidence (&lt; 0.6), no backend or an error use MARINA_ROUTE_FALLBACK (default `powerful` if present, else the last route). |  |

## Forecasting

| Variable | Description | Flags |
|---|---|---|
| `MARINA_FORECAST_ANALYSTS=openrouter/deepseek/deepseek-v4-pro,openrouter/anthropic/claude-sonnet-5,openrouter/openai/gpt-6-luna`<br>`MARINA_FORECAST_RETRIEVER=openrouter-web:openai/gpt-6-luna`<br>`MARINA_FORECAST_JUDGE=jev` | `forecast`, `bun run forecast` and POST /v1/forecast (docs/guides/forecasting.md). The defaults need OPENROUTER_API_KEY. Analysts are a comma list of models (defaults: DeepSeek V4 Pro, Claude Sonnet 5 and GPT-6 Luna via OpenRouter); the retriever defaults to OpenRouter web search on GPT-6 Luna; the judge is jev, decisions (the MARINA_DECISIONS backend, falling back to jev) or none. |  |

## Social Simulation Arena

| Variable | Description | Flags |
|---|---|---|
| `MARINA_ARENA_ENTRANT=<your-entrant-id>`<br>`MARINA_ARENA_KEY_FILE=/srv/marina/arena-key.pem`<br>`MARINA_ARENA_KEY_ID=k1` | Signed participation in the MIT Social Simulation Arena (docs/guides/arena.md). Off unless an entrant id is set. The key file holds the Ed25519 private key (mode 0600, `bun run arena keygen <path>`). | restart |
| `MARINA_ARENA_AUTOPILOT=off`<br>`MARINA_ARENA_WINDOW_HOURS=24` | File each round automatically during its last MARINA_ARENA_WINDOW_HOURS hours (0–168). |  |
| `MARINA_ARENA_FORECASTER=baseline`<br>`MARINA_ARENA_MODEL_WEIGHT=0.5` | What answers: baseline, nowcast (freshest Civiqs reading), discovered (best promoted signal, else nowcast), model:&lt;provider/model&gt;, crew:&lt;m&gt;[,&lt;m&gt;,&lt;m&gt;] (statistician, analyst, skeptic) or research:&lt;m&gt;[,&lt;m&gt;,&lt;m&gt;]. A model's answer is shrunk toward the baseline by MARINA_ARENA_MODEL_WEIGHT. Measure with `bun run arena evaluate` before switching. |  |
| `MARINA_ARENA_CIVIQS_LIVE=on` | `off` stops the nowcast reading the live Civiqs dashboard for open rounds (rounds past their lock never do). |  |
| `MARINA_ARENA_TRENDS_PARTIAL=off` | `on` counts a Google Trends basket's partial current week as its latest reading. |  |
| `MARINA_ARENA_RESEARCH_RETRIEVER=openrouter-web:openai/gpt-6-luna`<br>`MARINA_ARENA_RESEARCH_JUDGE=jev`<br>`MARINA_ARENA_RESEARCH_TRUST=0.5` | Research forecaster: retriever, judge (jev, decisions or none; default jev, or none without OPENROUTER_API_KEY) and the trust given to verified research lines. |  |
| `MARINA_ARENA_SHADOW=` | Record a candidate forecaster hourly in shadow, never filed (`bun run arena shadow score`). |  |
| `MARINA_ARENA_PROPOSER=openrouter/anthropic/claude-sonnet-5` | Model that proposes signals for `arena discover`. |  |
| `MARINA_ARENA_URL=https://social-simulation-arena.com`<br>`MARINA_ARENA_AUDIENCE=ssa-production-v1`<br>`MARINA_ARENA_DATA_URL=https://raw.githubusercontent.com/Social-Atoms/social-sim-arena/main` | Rehearsal overrides for the arena endpoint, audience and data repository. Production is the default. |  |

## TabH2O

| Variable | Description | Flags |
|---|---|---|
| `TABH2O_API_KEY=` | H2O.ai's hosted tabular foundation model, used by `market forecast`. Without a key the connector is seeded but inactive. The endpoint override is for self-hosted deployments. | secret |
| `TABH2O_ENDPOINT=https://tabh2o.h2oai.com/api/v1/predict` | H2O.ai's hosted tabular foundation model, used by `market forecast`. Without a key the connector is seeded but inactive. The endpoint override is for self-hosted deployments. |  |

## Prediction markets

| Variable | Description | Flags |
|---|---|---|
| `MARINA_TRADING_ENABLED=false` | `true` allows live order placement (Kalshi only). `position` is paper trading by default. | protected |
| `KALSHI_API_KEY=`<br>`KALSHI_API_SECRET=` | Kalshi credentials for live trading (the key is a UUID; the secret is a base64-encoded RSA private key in PEM form) and an API base override. | secret |
| `KALSHI_BASE=https://api.elections.kalshi.com/trade-api/v2` | Kalshi credentials for live trading (the key is a UUID; the secret is a base64-encoded RSA private key in PEM form) and an API base override. |  |
| `POLYMARKET_GAMMA_BASE=https://gamma-api.polymarket.com` | Polymarket market-data base override. Market data works; live Polymarket orders are not implemented. |  |
| `POLYMARKET_API_KEY=`<br>`POLYMARKET_API_SECRET=`<br>`POLYMARKET_PRIVATE_KEY=` | Reserved Polymarket credentials for live orders, which are not implemented yet (the signing path returns an error). | secret, internal |

## Memory

| Variable | Description | Flags |
|---|---|---|
| `MARINA_MEMORY_MAX_BYTES=1073741824`<br>`MARINA_MEMORY_MAX_SOURCES=100000`<br>`MARINA_MEMORY_MAX_REVISIONS=100000`<br>`MARINA_MEMORY_MAX_SPACES=256` | Per-owner admission budgets for durable memory (world and standalone service), aggregated across spaces: logical bytes, sources, revisions and spaces. Unlimited under the local profile unless set; the values shown are the shared/public defaults. Existing data is never evicted, and reads and forgetting keep working at the limit. |  |
| `MARINA_MEMORY_FEDERATION_CONFIG=` | Operator-owned JSON file of explicit memory federation mounts. Each entry binds a local principal to a peer URL and space, and names the environment variable holding the peer credential (see docs/guides/memory-service.md). | restart |
| `MARINA_MEMORY_PLANNER_URL=http://127.0.0.1:3300/v1`<br>`MARINA_MEMORY_PLANNER_MODEL=marina` | Optional model-directed memory plans. URL and model must both be set; unset gives deterministic, model-free plans. | restart |
| `MARINA_MEMORY_PLANNER_TOKEN=` | Optional model-directed memory plans. URL and model must both be set; unset gives deterministic, model-free plans. | secret, restart |
| `MARINA_MEMORY_EMBEDDINGS=none`<br>`MARINA_MEMORY_EMBEDDING_CACHE=data/memory-models`<br>`MARINA_MEMORY_EMBEDDING_LOCAL_ONLY=false`<br>`MARINA_MEMORY_EMBEDDING_URL=http://127.0.0.1:11434`<br>`MARINA_MEMORY_EMBEDDING_MODEL=`<br>`MARINA_MEMORY_EMBEDDING_REVISION=` | Memory embeddings: none (lexical only), local (pinned MiniLM through the optional extensions/local-embeddings) or ollama (an operator-run /api/embed with a model and an immutable revision). Evidence-gated: run `bun run qualify:paraphrase` first. | restart |

## Passthru and prompt caching

| Variable | Description | Flags |
|---|---|---|
| `MARINA_PASSTHRU_SHARED_POOLS=` | Comma-separated pool names shared with passthru (external OpenAI-SDK) callers. Empty shares none. |  |
| `MARINA_PASSTHRU_INJECT_BYTES=2048` | Bytes of memory context injected into a proxied request for an identified passthru caller (clamped 256–65536). The entity property passthruInjectBytes overrides it per key. |  |
| `MARINA_PASSTHRU_RESPONSE_CACHE=off`<br>`MARINA_PASSTHRU_RESPONSE_CACHE_TTL_MS=3600000` | Exact-match response cache for identified passthru callers. `on` applies only under the local profile; elsewhere a caller opts in with the entity property passthruResponseCache. Streaming, tool-call and non-2xx responses are never cached. |  |
| `MARINA_ANTHROPIC_AUTO_CACHE=false` | Add an ephemeral cache marker to the last system block of Anthropic passthru requests that carry none. Default true under the local profile, false otherwise. |  |
| `MARINA_COMPAT=openai` | Comma-separated drop-in compatibility profiles whose model-id aliases appear in /v1/models (`openai` exposes `assistant`). Default all; `none` disables. |  |

## HTTP hardening

| Variable | Description | Flags |
|---|---|---|
| `MARINA_MAX_REQUEST_BODY_BYTES=8388608`<br>`MARINA_MAX_UPLOAD_BYTES=52428800` | Request body ceiling for the HTTP port, and the separate cap on one asset upload (uploads are MIME-allowlisted and magic-byte checked). | restart |
| `MARINA_MCP_SESSIONS_PER_MIN=10` | MCP session creations and login/auth tool calls per client IP per minute. 0 disables. |  |
| `MARINA_MCP_ALLOWED_HOSTS=mcp.example.com` | Extra Host header values /mcp accepts (DNS-rebinding protection). Loopback spellings are always allowed; on a non-loopback bind Host validation is off until you list your public hostnames here. | protected |
| `MARINA_URL_GUARD_DNS_FAIL_OPEN=false` | `true` lets outbound fetches proceed when DNS resolution fails, instead of refusing them (fail open). Only for restricted-DNS environments. | protected |

## Retention

| Variable | Description | Flags |
|---|---|---|
| `MARINA_RETENTION_OVERRIDES=primitive_usage=30d,feed_events=0` | Override row-retention windows: comma-separated table=&lt;duration\|rows\|0&gt;, durations in s/m/h/d/w, a bare integer is a row count, 0 never prunes. Per-class defaults and the table list live in src/engine/retention.ts (Admin → Ops shows them); append-only tables can never be pruned. |  |
| `MARINA_EVENT_RETENTION=100000` | Durable event_log rows kept (pruned hourly; clamped 10000–10000000). |  |
| `MARINA_LOG_RETENTION=10000` | Structured application log rows kept in SQLite (maximum 1000000). | restart |

## Logging and OpenTelemetry

| Variable | Description | Flags |
|---|---|---|
| `LOG_FORMAT=text`<br>`LOG_LEVEL=info` | Log format (text or json) and minimum level (debug, info, warn, error). | restart |
| `MARINA_OTLP_ENABLED=false` | `true` pushes completed structural spans to an OTLP/HTTP JSON collector. Prompts, outputs, tool arguments and credentials are excluded; a collector outage never blocks agents. | restart |
| `MARINA_OTLP_LOGS_ENABLED=false` | `true` pushes logs over OTLP/HTTP JSON, independently of traces. | restart |
| `OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example` | Shared OTLP base endpoint (Marina appends /v1/traces or /v1/logs), headers (comma-separated, percent-encoded key=value, never displayed), timeout (default 10s, clamped 100ms–60s) and protocol (only http/json is supported). Each has a per-signal OTEL_EXPORTER_OTLP_TRACES_* or OTEL_EXPORTER_OTLP_LOGS_* variant that wins; per-signal endpoints are used exactly as written. | restart |
| `OTEL_EXPORTER_OTLP_HEADERS=` | Shared OTLP base endpoint (Marina appends /v1/traces or /v1/logs), headers (comma-separated, percent-encoded key=value, never displayed), timeout (default 10s, clamped 100ms–60s) and protocol (only http/json is supported). Each has a per-signal OTEL_EXPORTER_OTLP_TRACES_* or OTEL_EXPORTER_OTLP_LOGS_* variant that wins; per-signal endpoints are used exactly as written. | secret, restart |
| `OTEL_EXPORTER_OTLP_TIMEOUT=10s`<br>`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`<br>`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=` | Shared OTLP base endpoint (Marina appends /v1/traces or /v1/logs), headers (comma-separated, percent-encoded key=value, never displayed), timeout (default 10s, clamped 100ms–60s) and protocol (only http/json is supported). Each has a per-signal OTEL_EXPORTER_OTLP_TRACES_* or OTEL_EXPORTER_OTLP_LOGS_* variant that wins; per-signal endpoints are used exactly as written. | restart |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS=` | Shared OTLP base endpoint (Marina appends /v1/traces or /v1/logs), headers (comma-separated, percent-encoded key=value, never displayed), timeout (default 10s, clamped 100ms–60s) and protocol (only http/json is supported). Each has a per-signal OTEL_EXPORTER_OTLP_TRACES_* or OTEL_EXPORTER_OTLP_LOGS_* variant that wins; per-signal endpoints are used exactly as written. | secret, restart |
| `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT=`<br>`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=` | Shared OTLP base endpoint (Marina appends /v1/traces or /v1/logs), headers (comma-separated, percent-encoded key=value, never displayed), timeout (default 10s, clamped 100ms–60s) and protocol (only http/json is supported). Each has a per-signal OTEL_EXPORTER_OTLP_TRACES_* or OTEL_EXPORTER_OTLP_LOGS_* variant that wins; per-signal endpoints are used exactly as written. | restart |
| `OTEL_EXPORTER_OTLP_LOGS_HEADERS=` | Shared OTLP base endpoint (Marina appends /v1/traces or /v1/logs), headers (comma-separated, percent-encoded key=value, never displayed), timeout (default 10s, clamped 100ms–60s) and protocol (only http/json is supported). Each has a per-signal OTEL_EXPORTER_OTLP_TRACES_* or OTEL_EXPORTER_OTLP_LOGS_* variant that wins; per-signal endpoints are used exactly as written. | secret, restart |
| `OTEL_EXPORTER_OTLP_LOGS_TIMEOUT=` | Shared OTLP base endpoint (Marina appends /v1/traces or /v1/logs), headers (comma-separated, percent-encoded key=value, never displayed), timeout (default 10s, clamped 100ms–60s) and protocol (only http/json is supported). Each has a per-signal OTEL_EXPORTER_OTLP_TRACES_* or OTEL_EXPORTER_OTLP_LOGS_* variant that wins; per-signal endpoints are used exactly as written. | restart |
| `OTEL_SERVICE_NAME=marina`<br>`OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,service.namespace=my-team` | Resource identity attached to exported spans and logs. | restart |
| `MARINA_OTLP_ALLOW_INSECURE=false` | `true` allows a plaintext (http) collector on a non-loopback host. | protected, restart |
| `MARINA_OTLP_BATCH_DELAY_MS=2000`<br>`MARINA_OTLP_LOGS_BATCH_DELAY_MS=2000`<br>`MARINA_OTLP_LOGS_MAX_QUEUE=2000` | Export batching: trace batch delay, log batch delay and log queue size. | restart |

## Extensions

| Variable | Description | Flags |
|---|---|---|
| `MARINA_PLUGINS=./plugins/hello` | Comma-separated directories of trusted host extensions, each containing a marina-plugin.json (docs/guides/extending.md). Nothing is downloaded; empty loads none. | protected, restart |

## World Collective

| Variable | Description | Flags |
|---|---|---|
| `MARINA_COLLECTIVE_START_TIMEOUT_MS=30000` | How long a child world may take to come up, in milliseconds (minimum 1000; the first boot applies every migration). |  |

## Command-line clients

| Variable | Description | Flags |
|---|---|---|
| `MARINA_URL=ws://localhost:3300` | Server URL for `marina connect`, `marina status`, the ACP bridge (scripts/acp.ts) and the routing CLIs. Read by those clients, not the server. | internal |
| `MARINA_TOKEN=` | Bearer token `marina status` and the routing CLIs send. Unset reuses the newest cached `marina connect` session for MARINA_URL. | secret, internal |
| `MARINA_CODE_FRESH=`<br>`MARINA_CODE_TASK_TIMEOUT_MS=600000` | Folder launcher (`marina [dir]`, `bun run code`): `1` uses a throwaway database deleted on exit (same as --fresh) instead of ~/.marina/projects/&lt;slug&gt;/marina.db, and the one-shot `marina -p` timeout in milliseconds (on timeout it sends `code stop` and exits 2). | internal |

## Set by Marina (do not set)

| Variable | Description | Flags |
|---|---|---|
| `MARINA_LOCAL_API_KEY=` | The local profile's generated model-API key, loaded from &lt;DB_PATH&gt;.local-api-key at boot. Do not set it yourself. | secret, protected, internal |
| `MARINA_COLLECTIVE_CHILD=` | Marks a World Collective child world, which lets `evolve trial` run there. Set by the collective manager; setting it on a parent world bypasses the trial fence. | protected, internal |
