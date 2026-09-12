// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import type { EmbeddingProvider } from "./embeddings";

/** The extension owns its dependencies. Keep its URL dynamic for core typechecking. */
export async function localEmbeddings(
  cacheDirectory: string,
  localOnly = false,
): Promise<EmbeddingProvider> {
  const extension = new URL("../../extensions/local-embeddings/", import.meta.url);
  for (const name of ["@huggingface/tokenizers", "onnxruntime-node"])
    if (!existsSync(new URL(`node_modules/${name}/package.json`, extension)))
      throw new Error(
        "Local embeddings require an explicit extension install: bun install --cwd extensions/local-embeddings --frozen-lockfile",
      );
  const entry = new URL("index.ts", extension).href;
  const provider = (await import(entry)) as {
    localEmbeddings(cache: string, localOnly: boolean): Promise<EmbeddingProvider>;
  };
  return provider.localEmbeddings(cacheDirectory, localOnly);
}
