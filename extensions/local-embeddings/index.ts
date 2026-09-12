// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmbeddingProvider } from "../../src/memory/embeddings";
import { MemoryError } from "../../src/memory/service-types";

export const LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const LOCAL_EMBEDDING_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";

const MODEL_FILES = {
  "tokenizer.json": "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  "tokenizer_config.json": "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  "onnx/model_quantized.onnx": "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
} as const;

async function modelFile(cache: string, name: keyof typeof MODEL_FILES, localOnly: boolean) {
  const path = join(cache, LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_REVISION, name);
  let bytes: Buffer | undefined;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const downloaded = !bytes;
  if (!bytes) {
    if (localOnly) throw new Error(`Pinned local embedding file is missing: ${path}`);
    const response = await fetch(
      `https://huggingface.co/${LOCAL_EMBEDDING_MODEL}/resolve/${LOCAL_EMBEDDING_REVISION}/${name}`,
      {
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok || !response.body)
      throw new Error(`Embedding download failed: ${name} (${response.status})`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 32 * 1024 * 1024)
        throw new Error(`Embedding file exceeds pinned model limit: ${name}`);
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== MODEL_FILES[name])
    throw new Error(`Embedding file integrity check failed: ${path}`);
  if (downloaded) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  return { path, bytes };
}

/** Optional Apache-2.0 tokenizer/model and MIT ONNX runtime. No image libraries.
 * Complete character coverage, bounded tokenizer-checked chunks, normalized
 * mean pooling. The preprocessing identity is part of the persisted index key. */
export async function localEmbeddings(
  cacheDirectory: string,
  localOnly = false,
): Promise<EmbeddingProvider> {
  const [{ Tokenizer }, ort] = await Promise.all([
    import("@huggingface/tokenizers"),
    import("onnxruntime-node"),
  ]);
  const [tokens, config, model] = await Promise.all([
    modelFile(cacheDirectory, "tokenizer.json", localOnly),
    modelFile(cacheDirectory, "tokenizer_config.json", localOnly),
    modelFile(cacheDirectory, "onnx/model_quantized.onnx", localOnly),
  ]);
  const tokenizer = new Tokenizer(
    JSON.parse(tokens.bytes.toString()),
    JSON.parse(config.bytes.toString()),
  );
  const session = await ort.InferenceSession.create(model.path, {
    executionProviders: ["cpu"],
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
  });
  return {
    id: `${LOCAL_EMBEDDING_MODEL}@${LOCAL_EMBEDDING_REVISION}:onnx1.21-tokenizers0.2-q8-mean-chunks500-v2`,
    async embed(text) {
      if (Buffer.byteLength(text) > 65536)
        throw new MemoryError(413, "embedding_capacity", "Local embedding input exceeds 64 KiB");
      const pending: string[] = [];
      for (let i = 0; i < text.length; i += 500) pending.push(text.slice(i, i + 500));
      const chunks: string[] = [];
      while (pending.length) {
        const chunk = pending.shift()!;
        const encoded = tokenizer.encode(chunk);
        if (encoded.ids.length <= 256) chunks.push(chunk);
        else {
          const middle = Math.floor(chunk.length / 2);
          if (!middle)
            throw new MemoryError(
              413,
              "embedding_capacity",
              "Cannot represent input within the model window",
            );
          pending.unshift(chunk.slice(0, middle), chunk.slice(middle));
        }
        if (pending.length + chunks.length > 512)
          throw new MemoryError(413, "embedding_capacity", "Local embedding chunk limit exceeded");
      }
      const sum = new Array<number>(384).fill(0);
      for (const chunk of chunks) {
        const encoded = tokenizer.encode(chunk);
        const length = encoded.ids.length;
        const tensor = (values: number[]) =>
          new ort.Tensor("int64", BigInt64Array.from(values.map(BigInt)), [1, length]);
        const outputs = await session.run({
          input_ids: tensor(encoded.ids),
          attention_mask: tensor(encoded.attention_mask),
          token_type_ids: tensor(new Array<number>(length).fill(0)),
        });
        const result = outputs.last_hidden_state;
        if (!result || result.dims[1] !== length || result.dims[2] !== 384)
          throw new MemoryError(502, "invalid_embedding", "Unexpected local model output");
        const pooled = new Array<number>(384).fill(0);
        for (let token = 0; token < length; token++)
          for (let dimension = 0; dimension < 384; dimension++)
            pooled[dimension] =
              pooled[dimension]! + Number(result.data[token * 384 + dimension]) / length;
        const norm = Math.sqrt(pooled.reduce((total, value) => total + value * value, 0));
        if (!norm) throw new MemoryError(502, "invalid_embedding", "Empty local model output");
        for (let i = 0; i < sum.length; i++) sum[i] = sum[i]! + (pooled[i]! / norm) * chunk.length;
      }
      const norm = Math.sqrt(sum.reduce((total, x) => total + x * x, 0));
      if (!norm) throw new MemoryError(502, "invalid_embedding", "Empty local embedding");
      return sum.map((x) => x / norm);
    },
  };
}
