// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** The operator flow: publish a world, then import it free and paid through the CLI. */

import { afterEach, expect, it, spyOn } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueEntitlement } from "../../../src/learned/entitlement";
import { scopeProcessState } from "../../../test/process-state";
import { main } from "../cli";
import { cleanupTemp, publisherKey, publishSpec, tempDir, writeWorldPayload } from "./fixtures";

afterEach(cleanupTemp);

async function capture(argv: string[]): Promise<string> {
  let out = "";
  const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  try {
    await main(argv);
  } finally {
    spy.mockRestore();
  }
  return out;
}

it("publishes, then imports the free core and the paid slice, without printing key material", async () => {
  const dir = tempDir();
  const pub = publisherKey();
  const keyFile = join(dir, "publisher.key");
  writeFileSync(keyFile, pub.key, { mode: 0o600 });
  const payload = join(dir, "payload");
  writeWorldPayload(payload, { roomCode: true });
  const specFile = join(dir, "spec.json");
  writeFileSync(specFile, JSON.stringify(publishSpec()));
  const bundle = join(dir, "bundle");
  const published = JSON.parse(
    await capture(["publish", payload, bundle, specFile, "--key-file", keyFile]),
  );
  expect(published.artifact_id).toStartWith("marina-world:");
  expect(JSON.stringify(published)).not.toContain(pub.key);

  const config = join(dir, "market.json");
  writeFileSync(
    config,
    JSON.stringify({
      publishers: [{ name: "acme", public_key: pub.pinned.publicKey }],
      audit_log: "audit.jsonl",
    }),
  );
  using _state = scopeProcessState({
    env: {
      MARINA_UPSTREAM: "on",
      DB_PATH: join(dir, "m.db"),
      MARINA_LEARNED_PUBLISHER_KEYS: undefined,
    },
  });
  const free = JSON.parse(await capture(["import", bundle, "--config", config]));
  expect(free).toMatchObject({ added: 1, entitlement: null, network_used: false });
  expect(free.withheld).toBeGreaterThan(0);

  const token = issueEntitlement(
    {
      artifact_id: published.artifact_id,
      version_range: "^1.0.0",
      tiers: ["tier:standard"],
      licensee: { label: "buyer" },
      not_after: new Date(Date.now() + 86_400_000).toISOString(),
    },
    pub.key,
  );
  const proofFile = join(dir, "proof.json");
  writeFileSync(proofFile, JSON.stringify({ kind: "token", token }), { mode: 0o600 });
  const paid = JSON.parse(
    await capture([
      "import",
      bundle,
      "--slices",
      "tier:standard",
      "--proof",
      proofFile,
      "--config",
      config,
    ]),
  );
  expect(paid).toMatchObject({ trust: "imported", entitlement: { licensee: "buyer" } });
  expect(paid.withheld).toBe(0);

  // A world-readable proof file is refused rather than silently used.
  writeFileSync(join(dir, "loose.json"), JSON.stringify({ kind: "token", token }), { mode: 0o644 });
  await expect(
    main([
      "import",
      bundle,
      "--slices",
      "tier:standard",
      "--proof",
      join(dir, "loose.json"),
      "--config",
      config,
    ]),
  ).rejects.toThrow("chmod 600");

  const audit = JSON.parse(await capture(["audit-verify", "--config", config]));
  expect(audit.ok).toBe(true);
  expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).not.toContain(pub.key);
});
