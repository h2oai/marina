# Optional local embedding provider

The standard Marina install and symbolic memory service require no embedding packages.
From the Marina package/repository root, explicitly install this extension with:

```bash
bun install --cwd extensions/local-embeddings --frozen-lockfile
bun run memory serve --embeddings local
```

This installs the pinned tokenizer and ONNX runtime only inside this extension.
The local-provider CLI downloads the pinned MiniLM model on first use, verifies its
SHA-256 hashes and caches it. Use `--local-only` with an existing `--model-cache`
to disallow downloads. See the memory service guide for the complete CLI.

Text, symbols, evidence and revisions remain canonical. Vectors are rebuildable
retrieval indexes. This extension is a small retrieval baseline, not a claim of
superior agent performance. Tokenizer/model: Apache-2.0; ONNX Runtime: MIT.

The runtime is pinned to `onnxruntime-node` 1.31.1, and the provider ID names it
(`…:onnx1.31-tokenizers0.2-q8-mean-chunks500-v2`). Changing the runtime changes the
provider ID, so existing optional vectors must be reindexed. Original sources and
symbolic retrieval are unaffected.

Since 1.29, ONNX Runtime ships a telemetry uploader that is on by default on Linux
and macOS: on every session it reports model and device details to Microsoft's
1DS collector (`mobile.events.data.microsoft.com`). Its documented switch is
`ORT_DISABLE_TELEMETRY=1` in the process environment before the runtime
initializes, which stops the uploader, the events and the persistent device
identifier. Bun's `process.env` does not reach the native environment, so
`telemetry.ts` writes the switch through the C library (the Windows API on
Windows) before the runtime is imported, and refuses to load the runtime if it
cannot. A value you set yourself is kept. Checked on Linux: with the switch the
process opens no connection once the model is cached; without it, the runtime
connects to the collector right after session creation.
