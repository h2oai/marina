# Marina Architecture — Deep Dives

These pages hold the long-form design, history, measurements, and per-feature walkthroughs that used to live in `CLAUDE.md`. `CLAUDE.md` now keeps only what a contributor must follow to make a correct change and points here for the rest. Each page opens with a "when to read this" paragraph. User-facing how-to guides live in [`docs/guides/`](../guides/README.md).

| Page | Covers |
|---|---|
| [civic-substrate.md](civic-substrate.md) | Standing ledger and decay, rank derivation, the 10 safety gates, trust profile (`local` / `shared` / `public`), autonomy posture and witness ladder, exec-approver chain, Code Mode dispatch, Flywheel sandbox boundary |
| [chronicle.md](chronicle.md) | Chronicle table, read/write commands, Chronicler agent, citation → standing, `/who/<name>` pages (design note: [`docs/chronicle.md`](../chronicle.md)) |
| [worlds.md](worlds.md) | World templates and the `MARINA_WORLD` catalogue, `seed()` semantics, room-agent spawning, auth, and cost control |
| [agent-cognition.md](agent-cognition.md) | Identity and principles, the 10-section continuation prompt, tool profiles and prompt budget, role composition and PRISM gating, in-world trait/role editing, fast crew dispatch, platform-level cognitive commands |
| [memory.md](memory.md) | Legacy notes vs. durable service, unified context tiers, legacy bridge and twins, hygiene and dispatch ticks, adoption/ratification, reputation-weighted retrieval, retrieval quality, gateway/receipts/response cache, contradiction `resolve`, workflows, benchmarks |
| [orchestration.md](orchestration.md) | The 10 orchestration patterns, members-only crew pools, crew briefs and formation mediators |
| [dashboard.md](dashboard.md) | Canvas intents, WebSocket event taxonomy, layer toggles, MEMORY layer, Admin → Memory tab, memory observability API and hygiene ratios (user guide: [`docs/guides/dashboard.md`](../guides/dashboard.md)) |
| [resolvers.md](resolvers.md) | Resolver primitive and sample taxonomy, `probe`/`watch`, calibration finder registry, `position` invariants, SDK client, TabH2O integration |
| [traces.md](traces.md) | Causal tracing end-to-end, `trace` command and `/api/traces`, judgments ledger, adaptive routing |
| [security.md](security.md) | API authentication, rate limits, 2026-09-22 HTTP hardening, login limits, better-auth, SSRF guard, gateway auth and protocol, dashboard scoping, adapter persistence |
| [passthru.md](passthru.md) | Compat profiles, OpenAI/Responses surface, Anthropic upstream (text blocks, system messages, tool calling, error codes, caching, provider probe), Ollama surface, ACP bridge |
| [persistence.md](persistence.md) | Append-only migrations, row retention policies, the two durable-key passes |
