// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { environmentCatalog } from "../../src/config/environment";
import { FEATURE_STATUS } from "../../src/config/feature-status";
import { commandManifest } from "../../src/engine/command-manifest";
import { Engine } from "../../src/engine/engine";
import {
  BUILTIN_DEFAULT_MODELS,
  getDefaultUpstreamModel,
  LOCAL_DEFAULT_MODEL_KEYS,
} from "../../src/net/model/default-models";
import { consumersFor } from "../../src/outcomes/record";
import { MarinaDB } from "../../src/persistence/database";
import type { OutcomeKind } from "../../src/persistence/db-outcomes";
import { BUILTIN_WORLDS, loadBuiltinWorld } from "../../src/world/builtin-worlds";
import { inspectSources } from "./source";

export const root = resolve(import.meta.dir, "../..");

export async function buildInventory() {
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const trackedAndNew = [
    ...new Set([
      ...git(["ls-files", "-z"]).split("\0"),
      ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
    ]),
  ];
  const paths = trackedAndNew
    .filter(
      (p) =>
        (/\.(?:[cm]?[jt]sx?|py|sh|bash|c|rs|go|ya?ml|astro)$/.test(p) ||
          /(^|\/)Dockerfile(?:\.|$)/.test(p)) &&
        !/\.d\.ts$|\.(?:test|spec)\.|(^|\/)(?:test|e2e|fixtures|node_modules|dist)\/|(^|\/)test_[^/]+\.py$/.test(
          p,
        ),
    )
    .sort();
  const files = paths.map((file) => ({ file, text: readFileSync(resolve(root, file), "utf8") }));
  const source = inspectSources(files);
  const worldRooms = [];
  for (const slug of Object.keys(BUILTIN_WORLDS).sort()) {
    const world = await loadBuiltinWorld(slug);
    for (const [room, module] of Object.entries(world.rooms)) {
      if (!module.commands && !module.onTick) continue;
      worldRooms.push({
        world: slug,
        room,
        commands: Object.entries(module.commands ?? {}).map(([name, handler]) => ({
          name,
          handler: handler.toString(),
        })),
        onTick: module.onTick?.toString(),
      });
    }
  }
  const reference = environmentCatalog(
    readFileSync(resolve(root, "config/environment.reference"), "utf8"),
  ).filter((e) => e.key.startsWith("MARINA_"));
  const db = new MarinaDB(":memory:");
  const engine = new Engine({ db, sandboxes: [] });
  try {
    const commands = commandManifest(engine.commands).sort((a, b) => a.name.localeCompare(b.name));
    const tickJobs = engine.describeTickSchedule();
    const providerDefaults = Object.keys({
      ...BUILTIN_DEFAULT_MODELS,
      ...LOCAL_DEFAULT_MODEL_KEYS,
    }).map((key) => ({
      name: `MARINA_DEFAULT_${key.replace(/_API_KEY$/, "")}_MODEL`,
      providerKey: key,
      default: getDefaultUpstreamModel(key, {}),
      source: "src/net/model/default-models.ts",
      expression: "getDefaultUpstreamModel(providerKey, {})",
      conditional: !!LOCAL_DEFAULT_MODEL_KEYS[key],
    }));
    const envNames = new Set([
      ...source.environment.map((e) => e.name),
      ...reference.map((e) => e.key),
      ...providerDefaults.map((e) => e.name),
    ]);
    const environment = [...envNames].sort().map((name) => {
      const catalog = reference.find((e) => e.key === name);
      const sites = source.environment.find((e) => e.name === name)?.sites ?? [];
      return {
        name,
        generatedDefault: providerDefaults.find((e) => e.name === name),
        catalog,
        codeDefaults: sites.filter((s) =>
          ["read", "helper-argument", "non-js-source"].includes(s.role),
        ),
        references: sites.filter(
          (s) => !["read", "helper-argument", "non-js-source"].includes(s.role),
        ),
        indirectReaders: source.dynamicEnvironment.filter((s) =>
          sites.some((r) => r.file === s.file),
        ),
        defaultStatus: providerDefaults.some((e) => e.name === name)
          ? "code-generated"
          : sites.some((s) => ["read", "helper-argument", "non-js-source"].includes(s.role))
            ? "source-expressions"
            : "requires-indirect-read-resolution",
      };
    });
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      provenance: {
        commit: git(["rev-parse", "HEAD"]),
        branch: git(["branch", "--show-current"]),
        dirty: !!git(["status", "--porcelain"]),
        bun: Bun.version,
        sources: [
          ...new Set([
            ...paths,
            ...trackedAndNew.filter((file) => /^(src|worlds|config|seeds|benchmarks)\//.test(file)),
            "package.json",
            "bun.lock",
            ".bun-version",
          ]),
        ]
          .filter(Boolean)
          .sort()
          .map((file) => ({
            file,
            sha256: createHash("sha256")
              .update(readFileSync(resolve(root, file)))
              .digest("hex"),
          })),
      },
      counts: {
        commands: commands.length,
        forms: commands.reduce((n, c) => n + (c.forms?.length ?? 0), 0),
        roomCommands: source.roomCommands.length,
        tickJobs: tickJobs.length,
        environment: environment.length,
        features: FEATURE_STATUS.length,
      },
      commands,
      roomCommands: source.roomCommands,
      roomCommandBindings: source.roomCommandBindings,
      worldRooms,
      ticks: {
        intervalMs: engine.config.tickInterval,
        periodic: tickJobs,
        everyTick: source.everyTick,
      },
      environment,
      dynamicEnvironment: source.dynamicEnvironment,
      outcomes: {
        ...source.outcomes,
        routing: source.outcomes.kinds.flatMap((kind) =>
          (["mechanical", "judged"] as const).flatMap((basis) =>
            [undefined, "market", "conduct"].flatMap((source) =>
              [false, true].map((deliverJudged) => ({
                kind,
                basis,
                source: source ?? "other",
                deliverJudged,
                consumers: consumersFor(kind as OutcomeKind, basis, { source, deliverJudged }),
              })),
            ),
          ),
        ),
      },
      features: FEATURE_STATUS,
      limitations: [
        "Registry presence is not execution evidence. All declared forms are preserved; room handlers without schemas retain source and usage strings.",
        "Environment catalog values are examples, not defaults. codeDefaults preserves read expressions and containing code; conditional, helper and computed defaults require resolution. No host environment values are captured.",
        "Every-tick statements supplement the periodic registry. A registered job invocation without eligible data is not proof of its effect.",
        "Outcome call sites and transitive candidates require review for aliases/dynamic calls/raw SQL. Runtime routing is evaluated from consumersFor.",
      ],
    };
  } finally {
    await engine.shutdown();
    db.close();
  }
}

if (import.meta.main) {
  const output = process.argv[2];
  if (!output)
    throw new Error(
      "Usage: bun --no-env-file scripts/capabilities/inventory.ts /tmp/inventory.json",
    );
  const inventory = await buildInventory();
  await Bun.write(output, `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(JSON.stringify({ output, ...inventory.counts }));
}
