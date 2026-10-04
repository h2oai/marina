# Running on a single model

Marina sizes itself to the intelligence it has. Several vendors give it cross-vendor analysts, independent checkers and routing choices. A single model — one local runtime such as Ollama or llama.cpp, or one cloud key — still runs every model-using feature, and the weaker form is labelled **degraded**. Only zero models is an error.

## Point Marina at a local model

Any OpenAI-compatible server works. Set its base URL (and the model id it serves) in `.env`:

```bash
# Ollama (keyless)
OLLAMA_BASE_URL=http://localhost:11434/v1
MARINA_DEFAULT_OLLAMA_MODEL=qwen3:4b

# or llama.cpp's llama-server
LLAMA_BASE_URL=http://localhost:8080/v1
MARINA_DEFAULT_LLAMA_MODEL=local-model
# LLAMA_API_KEY=…   # only when the server runs with --api-key
```

Setting the base URL (or the key) opts the runtime in. It becomes the first fallback for `marina/default`, so crews, room agents and agents spawned without a model use it. Address it directly as `ollama/<id>` or `llama/<id>`. The context window is probed at launch; pin it with `OLLAMA_CONTEXT_WINDOW` / `LLAMA_CONTEXT_WINDOW` when the probe is wrong. A small window shrinks the continuation prompt automatically.

One cloud key (for example only `ANTHROPIC_API_KEY`) is also a single-model installation. OpenRouter or the Hugging Face router counts as several models, because one key reaches many vendors.

## Check what you have

```
readiness
```

The **Intelligence scale** line reports `ok` with several models, and `degraded` with one, naming what changes. Model selection reads configuration only: no probe, no network call.

## What changes with one model

Resolution order is the same everywhere: explicit configuration first, then any available model, then `marina/default`.

| Feature | With several models | With one model |
|---|---|---|
| `forecast`, `bun run forecast`, `POST /v1/forecast` | One analyst per vendor; web retrieval through OpenRouter plus `search`; Jev judge | The one model as the only analyst, run K times; `search` over the configured backends (keyless DuckDuckGo at the end), its evidence budget sized to the model's context window; judged by the world's decision backend if one is set, otherwise equal weights. The answer carries `scale: { tier: "degraded", notes }` |
| Decisions (`MARINA_DECISIONS=classifier`) | Classifier on OpenRouter or a chosen host | The chat-classifier runs on the local runtime (base URL, model and key filled in). It is uncalibrated, so it gets the single-cut gate policy |
| Research judge (arena research, forecasts) | Jev through OpenRouter | The world's decision backend; none set ⇒ no judge, equal weights |
| `marina/verify:<model>` | `+<checker>` picks an independent checker | The proposer checks itself; `marina/verify:default` resolves to the available model |
| `model:route` | Routes between `MARINA_ROUTES` / tiers | One candidate: the available model, recorded as an `agent_decision` with verdict `single` |
| Seeded agents on boot | Spawn on their saved models | A saved vendor model whose key is missing runs on `marina/default` with a warning; the saved model is kept, so adding the key restores it. An explicit `agent spawn` with a missing key still fails fast |
| Crews, room agents | `marina/default` | `marina/default` → the local runtime |
| Arena research retriever | OpenRouter web search | Tavily if keyed, else `asof` |

Explicit settings always win. `MARINA_FORECAST_ANALYSTS`, `MARINA_FORECAST_RETRIEVER`, `MARINA_DECISION_BASE_URL`, `MARINA_ROUTES` and `+<checker>` behave exactly as before. Installations with several models behave as before.

## What a single model cannot give you

- **Independence.** A self-check shares the proposer's blind spots, and K runs of one model agree more than K vendors do. Agreement is therefore weaker evidence of confidence.
- **Calibration.** A chat-classifier's numbers are verbalized, not calibrated, so gates take one cut at 0.5 and send positives to the owner.
- **Fresh evidence at scale.** Keyless search is rate-limited and shallower than paid retrieval.

Treat degraded output as a working floor, not a measured result. Add a second vendor key, or an aggregator, when the comparison matters.

## Hardware

A 4B-parameter model (for example `qwen3:4b` in Ollama) runs on a CPU with 16 GB RAM; larger models want a GPU. Forecasts and verification multiply calls (K runs, a check per answer), so a slow local model makes them slow rather than broken.
