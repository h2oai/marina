// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { modelAccess } from "../src/model/access";
import { mcpAuthRequiredFromEnv } from "../src/net/api/ops-api";
import { selfModelToken } from "../src/net/model/self-model-token";
import {
  modelApiKeySecrets,
  parseModelApiKeyList,
  parseModelApiKeys,
} from "../src/net/model-api/api-keys";

describe("parseModelApiKeys", () => {
  const cases: Array<[string | undefined, ReturnType<typeof parseModelApiKeyList>]> = [
    [undefined, []],
    ["", []],
    [" , ,", []],
    ["sk-a", [{ secret: "sk-a" }]],
    [" sk-a , sk-b ", [{ secret: "sk-a" }, { secret: "sk-b" }]],
    ["sk-a:alice", [{ secret: "sk-a", entity: "alice" }]],
    ["sk-a : alice ", [{ secret: "sk-a", entity: "alice" }]],
    ["sk-a:", [{ secret: "sk-a" }]],
    ["sk-a:*", [{ secret: "sk-a", multiTenant: true }]],
    [":alice,sk-b", [{ secret: "sk-b" }]],
    ["sk-a:alice:x", [{ secret: "sk-a", entity: "alice:x" }]],
    [",sk-a,,sk-b:bob,", [{ secret: "sk-a" }, { secret: "sk-b", entity: "bob" }]],
  ];
  for (const [raw, expected] of cases) {
    it(`parses ${JSON.stringify(raw)}`, () => {
      expect(parseModelApiKeyList(raw)).toEqual(expected);
      expect(parseModelApiKeys({ MODEL_API_KEYS: raw })).toEqual(expected);
    });
  }

  it("secrets never include the bound name", () => {
    expect(modelApiKeySecrets({ MODEL_API_KEYS: "sk-a:alice, sk-b" })).toEqual(["sk-a", "sk-b"]);
  });
});

describe("every MODEL_API_KEYS reader agrees", () => {
  const env = { MODEL_API_KEYS: " , sk-first : alice ,sk-second" } as NodeJS.ProcessEnv;

  it("src/model access uses the first secret", () => {
    expect(modelAccess("marina/default", env).apiKey).toBe("sk-first");
  });

  it("the self-model token uses the first secret", async () => {
    expect(await selfModelToken(env)).toBe("sk-first");
  });

  it("the ops overview counts only real keys", () => {
    expect(mcpAuthRequiredFromEnv(true, env)).toBe(true);
    expect(mcpAuthRequiredFromEnv(true, { MODEL_API_KEYS: " , " } as NodeJS.ProcessEnv)).toBe(
      false,
    );
  });
});
