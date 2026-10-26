// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A zero-config first run: typo suggestions, provider validation, role verb
 * aliases, usage lines, the no-provider `ask` notice, the ungated trust line,
 * and one provider-setup hint derived from the registry.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderTrustProfileLine } from "../src/engine/commands/readiness";
import { closestName, editDistance } from "../src/engine/did-you-mean";
import { MODEL_DISCOVERY_PROVIDERS } from "../src/net/model/model-discovery";
import { cloudKeyEnvs, KEY_PROVIDERS, providerSetupHint } from "../src/net/model/provider-setup";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";
import { noProviderEnv } from "./hermetic-env";
import { scopeProcessState } from "./process-state";

describe("did you mean", () => {
  it("counts an adjacent swap as one edit", () => {
    expect(editDistance("hepl", "help")).toBe(1);
    expect(editDistance("lok", "look")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });

  it("suggests only within a small budget", () => {
    const names = ["look", "help", "say", "anthropic", "openai"];
    expect(closestName("lok", names)).toBe("look");
    expect(closestName("hepl", names)).toBe("help");
    expect(closestName("anthropc", names)).toBe("anthropic");
    expect(closestName("frobnicate", names)).toBeUndefined();
    expect(closestName("zz", names)).toBeUndefined();
  });
});

describe("provider setup hint", () => {
  it("is derived from the provider registry and names every way in", () => {
    const hint = providerSetupHint();
    for (const env of cloudKeyEnvs()) expect(hint).toContain(env);
    expect(cloudKeyEnvs()[0]).toBe("OPENROUTER_API_KEY");
    expect(hint).toContain("key add <name> <provider> <key>");
    expect(hint).toContain("OLLAMA_BASE_URL=");
    expect(hint).toContain("LLAMA_BASE_URL=");
    for (const provider of MODEL_DISCOVERY_PROVIDERS) expect(KEY_PROVIDERS).toContain(provider);
  });
});

describe("trust line", () => {
  it("ungated: says gates are off and how to enforce them, names no posture", () => {
    const line = renderTrustProfileLine({ profile: "local", ungated: true, autonomy: "guarded" });
    expect(line).toContain("LOCAL — ungated");
    expect(line).toContain("MARINA_AUTONOMY=guarded");
    expect(line).not.toContain("autonomy: guarded");
  });
});

describe("first-run commands", () => {
  let world: ReturnType<typeof createTestEngine>;
  let state: DisposableStack;

  beforeEach(() => {
    state = new DisposableStack();
    state.use(
      scopeProcessState({
        trustProfile: "local",
        env: {
          MARINA_AUTONOMY: undefined,
          ...noProviderEnv(),
        },
      }),
    );
    world = createTestEngine();
  });
  afterEach(async () => {
    await world.dispose();
    state.dispose();
  });

  async function run(raw: string): Promise<string> {
    const { connection, entityId } = world.login(`u${crypto.randomUUID().slice(0, 6)}`);
    connection.clear();
    await world.engine.processCommand(entityId, raw);
    return stripAnsi(connection.allTextJoined());
  }

  it("an unknown command suggests the nearest builtin", async () => {
    expect(await run("lok")).toContain('Unknown command: lok. Did you mean "look"?');
    expect(await run("hepl")).toContain('Did you mean "help"?');
    expect(await run("frobnicate")).not.toContain("Did you mean");
  });

  it("key add refuses an unknown provider with the closest name and the list", async () => {
    const reply = await run("key add foo anthropc sk-test");
    expect(reply).toContain('Unknown provider "anthropc". Did you mean "anthropic"?');
    expect(reply).toContain("Providers: ");
    expect(world.db.getApiKey("foo")).toBeFalsy();
    expect(await run("key add bar bogusprov abc")).toContain('Unknown provider "bogusprov"');
  });

  it("role accepts the show/ls/rm verb families", async () => {
    world.db.saveRole({
      name: "scout",
      description: "Scouts ahead.",
      traits: [],
      createdBy: "system",
    });
    expect(await run("role show scout")).toContain("scout");
    expect(await run("role show scout")).not.toContain("Usage: role list");
    expect(await run("role ls")).toContain("role(s) total");
    expect(await run("role frob")).toContain('Unknown role subcommand "frob"');
  });

  it("context with no query prints a usage line", async () => {
    expect(await run("memory context")).toBe("Usage: context <query> | context api <JSON>");
  });

  it("ask without a provider says it answers from notes only", async () => {
    const reply = await run("ask how do I spawn an agent");
    expect(reply).toContain("No model provider — answering from notes only; see `readiness`.");
  });
});
