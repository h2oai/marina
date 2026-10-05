// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** The operator flow through the CLI: keygen → publish → verify → issue → plan. */

import { afterEach, expect, it, spyOn } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli";
import { cleanupTemp, publishSpec, tempDir, writeWorldPayload } from "./fixtures";

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

it("runs the publisher and importer flow without printing key material", async () => {
  const dir = tempDir();
  const keyFile = join(dir, "publisher.pem");
  const keygen = JSON.parse(await capture(["keygen", keyFile]));
  expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(keygen)).not.toContain("PRIVATE KEY");

  const payload = join(dir, "world");
  writeWorldPayload(payload);
  const specFile = join(dir, "spec.json");
  writeFileSync(specFile, JSON.stringify(publishSpec()));
  const published = JSON.parse(await capture(["publish", payload, specFile, "--key", keyFile]));
  expect(published.artifact_id).toBe(`marina-world:${keygen.key_id}/research-lab`);

  const config = join(dir, "market.json");
  writeFileSync(
    config,
    JSON.stringify({
      publishers: [{ name: "acme", public_key: keygen.public_key }],
      audit_log: "audit.jsonl",
    }),
  );
  const verified = JSON.parse(await capture(["verify", payload, "--config", config]));
  expect(verified.slices).toEqual([
    { id: "core", access: "open" },
    { id: "standard", access: "token" },
  ]);

  const token = await capture([
    "issue",
    "--key",
    keyFile,
    "--artifact",
    published.artifact_id,
    "--tiers",
    "standard",
    "--licensee",
    "buyer",
    "--versions",
    "^1.0.0",
  ]);
  const proofFile = join(dir, "proof.json");
  writeFileSync(proofFile, token, { mode: 0o600 });
  const plan = JSON.parse(
    await capture([
      "plan-import",
      payload,
      "--slices",
      "core,standard",
      "--proof",
      proofFile,
      "--config",
      config,
    ]),
  );
  expect(plan.entitlement.licensee).toBe("buyer");
  expect(plan.trust).toBe("imported");

  // A world-readable proof file is refused rather than silently used.
  writeFileSync(join(dir, "loose.json"), token, { mode: 0o644 });
  await expect(
    main([
      "plan-import",
      payload,
      "--slices",
      "standard",
      "--proof",
      join(dir, "loose.json"),
      "--config",
      config,
    ]),
  ).rejects.toThrow("chmod 600");

  const audit = JSON.parse(await capture(["audit-verify", "--config", config]));
  expect(audit.ok).toBe(true);
  expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).not.toContain("PRIVATE");
});
