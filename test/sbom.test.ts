// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkSbom, lockedComponents, SYFT_VERSION } from "../scripts/generate-sbom";

const lock = `{
  // Bun lockfiles include JSON comments and trailing commas.
  "packages": {
    "dependency": ["dependency@1.2.3", "", {}, "sha512-example"],
    "@scope/nested": ["@scope/nested@4.5.6", "", {}],
    "native-linux": ["native-linux@7.8.9", "", {"os":"linux"}],
    "local": ["local@workspace:src/sdk"],
  },
}`;
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  components: [
    { name: "dependency", version: "1.2.3", "bom-ref": "a" },
    { group: "@scope", name: "nested", version: "4.5.6", "bom-ref": "b" },
    { name: "native-linux", version: "7.8.9", "bom-ref": "c" },
  ],
};

test("SBOM coverage includes scoped, transitive and platform packages from Bun JSONC", () => {
  const expected = lockedComponents(lock);
  expect([...expected]).toEqual(["dependency@1.2.3", "@scope/nested@4.5.6", "native-linux@7.8.9"]);
  expect(checkSbom(bom, expected)).toBe(3);
  expect(
    checkSbom(
      {
        ...bom,
        components: [...bom.components, { type: "file", name: "bun.lock", "bom-ref": "file" }],
      },
      expected,
    ),
  ).toBe(3);
  expect(() => checkSbom({ ...bom, components: bom.components.slice(0, 2) }, expected)).toThrow(
    "native-linux@7.8.9",
  );
});

test("SBOM qualification rejects empty, malformed, duplicate and wrong-version inventories", () => {
  expect(() => lockedComponents("{}")).toThrow();
  expect(() => lockedComponents('{"packages":{"bad":[]}}')).toThrow();
  expect(() => checkSbom({}, lockedComponents(lock))).toThrow();
  expect(() => checkSbom(bom, new Set())).toThrow("empty lockfiles");
  expect(() =>
    checkSbom(
      { ...bom, components: [...bom.components, bom.components[0]] },
      lockedComponents(lock),
    ),
  ).toThrow("duplicate");
  expect(() => checkSbom({ ...bom, specVersion: "1.0" }, lockedComponents(lock))).toThrow();
  expect(() =>
    checkSbom(
      {
        ...bom,
        components: bom.components.map((component) => ({ ...component, version: "0.0.0" })),
      },
      lockedComponents(lock),
    ),
  ).toThrow("coverage failed");
});

test("pull-request builds cannot sign; signing consumes the built artifact without running repository code", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(new URL("../.github/workflows/supply-chain.yml", import.meta.url), "utf8"),
  ) as {
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        if?: string;
        needs?: string;
        permissions?: Record<string, string>;
        steps: { uses?: string; run?: string; with?: Record<string, string> }[];
      }
    >;
  };
  expect(workflow.permissions).toEqual({ contents: "read" });
  const build = workflow.jobs.build!;
  const attest = workflow.jobs.attest!;
  expect(build.permissions?.["id-token"]).toBeUndefined();
  expect(attest.needs).toBe("build");
  expect(attest.if).toContain("github.event_name != 'pull_request'");
  expect(attest.if).toContain("refs/heads/main");
  expect(attest.permissions?.["id-token"]).toBe("write");
  expect(attest.steps.some((step) => step.run || step.uses?.includes("checkout"))).toBe(false);
  const signatures = attest.steps.filter((step) => step.uses?.startsWith("actions/attest@"));
  expect(signatures).toHaveLength(2);
  for (const step of signatures) {
    expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    expect(step.with?.["subject-path"]).toBe("dist/supply-chain/marina.tgz");
  }
  expect(signatures[1]!.with?.["sbom-path"]).toBe("dist/supply-chain/source.cdx.json");
  const setup = readFileSync(
    new URL("../.github/actions/setup-syft/action.yml", import.meta.url),
    "utf8",
  );
  expect(setup).toContain(`syft-version: v${SYFT_VERSION}`);
});
