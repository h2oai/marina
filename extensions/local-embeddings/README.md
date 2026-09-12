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
