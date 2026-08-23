// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface InheritanceArtifact {
  pool: string;
  author: string;
  content: string;
  noteType: string;
  importance: number;
  createdAt: number;
}

export interface InheritanceBundle {
  schema: "marina.inheritance.v1";
  assertedSource: string;
  createdAt: number;
  artifacts: InheritanceArtifact[];
}

const MAX_BUNDLE_BYTES = 16_384;
const MAX_ARTIFACTS = 12;

export function isExportableInheritancePool(name: string): boolean {
  return name === "guide" || name.startsWith("orchestration:") || name.startsWith("tradition:");
}

export function encodeInheritanceBundle(bundle: InheritanceBundle): string {
  const json = JSON.stringify(bundle);
  if (Buffer.byteLength(json) > MAX_BUNDLE_BYTES)
    throw new Error("Inheritance bundle is too large.");
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeInheritanceBundle(token: string): InheritanceBundle {
  if (!token || token.length > MAX_BUNDLE_BYTES * 2) throw new Error("Invalid inheritance token.");
  let parsed: unknown;
  try {
    const json = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.byteLength(json) > MAX_BUNDLE_BYTES)
      throw new Error("Inheritance bundle is too large.");
    parsed = JSON.parse(json);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "Inheritance bundle is too large.") throw cause;
    throw new Error("Inheritance token is not valid base64url JSON.");
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error("Inheritance bundle must be an object.");
  const row = parsed as Partial<InheritanceBundle>;
  if (row.schema !== "marina.inheritance.v1") throw new Error("Unsupported inheritance schema.");
  if (
    typeof row.assertedSource !== "string" ||
    !row.assertedSource.trim() ||
    row.assertedSource.length > 80 ||
    typeof row.createdAt !== "number" ||
    !Number.isFinite(row.createdAt) ||
    !Array.isArray(row.artifacts) ||
    row.artifacts.length === 0 ||
    row.artifacts.length > MAX_ARTIFACTS
  ) {
    throw new Error("Inheritance bundle metadata is invalid.");
  }
  for (const artifact of row.artifacts) validateArtifact(artifact);
  return row as InheritanceBundle;
}

export function inheritanceDigest(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function validateArtifact(value: unknown): asserts value is InheritanceArtifact {
  if (!value || typeof value !== "object") throw new Error("Inheritance artifact is invalid.");
  const row = value as Partial<InheritanceArtifact>;
  if (
    typeof row.pool !== "string" ||
    !isExportableInheritancePool(row.pool) ||
    typeof row.author !== "string" ||
    !row.author.trim() ||
    row.author.length > 80 ||
    typeof row.content !== "string" ||
    !row.content.trim() ||
    row.content.length > 1_000 ||
    typeof row.noteType !== "string" ||
    row.noteType.length > 40 ||
    typeof row.importance !== "number" ||
    !Number.isInteger(row.importance) ||
    row.importance < 0 ||
    row.importance > 10 ||
    typeof row.createdAt !== "number" ||
    !Number.isFinite(row.createdAt)
  ) {
    throw new Error("Inheritance artifact fields are invalid.");
  }
}
