// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  MarinaDB,
  ReproducibilityLevel,
  SimulationEventRow,
  SimulationMode,
} from "../../persistence/database";
import type { CommandDef, Entity } from "../../types";
import { getErrorMessage } from "../errors";
import { notFound } from "./command-messages";

const MODES = ["live", "recorded", "synthetic", "hybrid", "long-duration"] as const;
const LEVELS = [
  "exact-engine",
  "recorded-response",
  "behavioral",
  "statistical",
  "conceptual",
] as const;
const HELP = `Unified simulation laboratory.
Usage:
  lab manifest <scenario JSON>
  lab run <manifest-hash> | <mode> | <reproducibility> | <seed> [| treatments JSON]
  lab fork <parent-run> | <fork-point-ref> | <treatments JSON> [| seed]
  lab replicate <manifest-hash> | <mode> | <reproducibility> | <count> | <seed-prefix> [| treatments JSON]
  lab event <run> <started|intervention|observation|measure|completed|failed|gap> | <source-ref> | <data JSON>
  lab compare <run-ids csv> | <questions csv> | <measures JSON> | <interpretation>
  lab show <run>
  lab list`;
export function labCommand(deps: {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "lab",
    aliases: [],
    category: "Experiments",
    minRank: 0,
    help: HELP,
    handler: (ctx, input) => {
      const actor = deps.getEntity(input.entity);
      if (!actor) return;
      const sub = input.tokens[0]?.toLowerCase();
      const raw = input.args.slice(sub?.length ?? 0).trim();
      if (sub === "manifest") {
        // Require an explicit scenario — a bare `lab manifest` must show help,
        // not content-address a degenerate `{schema}`-only manifest.
        const manifest = raw ? parseObject(raw) : undefined;
        if (!manifest) {
          ctx.send(input.entity, HELP);
          return;
        }
        const row = deps.db.createSimulationManifest({ manifest, createdBy: String(actor.id) });
        ctx.send(
          input.entity,
          `Scenario manifest ${row.hash} created. Configuration alone does not imply exact reproducibility.`,
        );
        return;
      }
      if (sub === "run") {
        const [hash = "", modeText = "", levelText = "", seed = "", treatmentsText = "", ...extra] =
          fields(raw);
        if (
          !deps.db.getSimulationManifest(hash) ||
          !isMode(modeText) ||
          !isLevel(levelText) ||
          extra.length
        ) {
          ctx.send(input.entity, HELP);
          return;
        }
        const treatments = parseObject(treatmentsText);
        if (!treatments) {
          ctx.send(input.entity, "Treatments must be a JSON object.");
          return;
        }
        const row = deps.db.createSimulationRun({
          manifestHash: hash,
          mode: modeText,
          reproducibility: levelText,
          seed: seed || undefined,
          treatments,
          createdBy: String(actor.id),
        });
        try {
          deps.db.appendSimulationEvent({
            runId: row.id,
            kind: "started",
            data: { declarationOnly: true },
            createdBy: String(actor.id),
          });
        } catch (cause) {
          // Non-critical (the run row exists; the marker is decorative) — but a
          // real DB failure here likely precedes bigger ones, so surface it.
          console.warn(`[lab] started marker failed for ${row.id}:`, getErrorMessage(cause));
        }
        ctx.send(
          input.entity,
          `Run ${row.id} declared as ${row.mode}/${row.reproducibility}. Evidence must be recorded; no result was invented.`,
        );
        return;
      }
      if (sub === "fork") {
        const [parentId = "", forkPointRef = "", treatmentsText = "", seed = "", ...extra] =
          fields(raw);
        const parent = deps.db.getSimulationRun(parentId);
        if (!parent || !forkPointRef || extra.length) {
          ctx.send(input.entity, HELP);
          return;
        }
        const treatments = parseObject(treatmentsText);
        if (!treatments) {
          ctx.send(input.entity, "Treatments must be a JSON object.");
          return;
        }
        const row = deps.db.createSimulationRun({
          manifestHash: parent.manifest_hash,
          mode: parent.mode,
          reproducibility: parent.reproducibility,
          seed: seed || parent.seed || undefined,
          parentRunId: parent.id,
          forkPointRef,
          treatments,
          createdBy: String(actor.id),
        });
        ctx.send(
          input.entity,
          `Counterfactual ${row.id} branches from ${parent.id} at ${forkPointRef}.`,
        );
        return;
      }
      if (sub === "replicate") {
        const [
          hash = "",
          modeText = "",
          levelText = "",
          countText = "",
          seedPrefix = "",
          treatmentsText = "",
          ...extra
        ] = fields(raw);
        const count = Number(countText);
        if (
          !deps.db.getSimulationManifest(hash) ||
          !isMode(modeText) ||
          !isLevel(levelText) ||
          !Number.isInteger(count) ||
          count < 1 ||
          count > 100 ||
          !seedPrefix ||
          extra.length
        ) {
          ctx.send(input.entity, HELP);
          return;
        }
        const treatments = parseObject(treatmentsText);
        if (!treatments) {
          ctx.send(input.entity, "Treatments must be a JSON object.");
          return;
        }
        const ids = [];
        for (let i = 0; i < count; i++)
          ids.push(
            deps.db.createSimulationRun({
              manifestHash: hash,
              mode: modeText,
              reproducibility: levelText,
              seed: `${seedPrefix}:${i}`,
              treatments,
              createdBy: String(actor.id),
            }).id,
          );
        ctx.send(
          input.entity,
          `Declared ${ids.length} ${levelText} replications: ${ids.join(", ")}. They have no outcomes until observed.`,
        );
        return;
      }
      if (sub === "event") {
        const [head = "", sourceRef = "", dataText = "", ...extra] = fields(raw);
        const [rawRunId, kind, ...headExtra] = head.split(/\s+/);
        const runId = rawRunId ?? "";
        if (
          !deps.db.getSimulationRun(runId) ||
          !isEvent(kind) ||
          headExtra.length ||
          extra.length
        ) {
          ctx.send(input.entity, HELP);
          return;
        }
        const data = parseObject(dataText);
        if (!data) {
          ctx.send(input.entity, "Event data must be a JSON object.");
          return;
        }
        const row = deps.db.appendSimulationEvent({
          runId,
          kind,
          sourceRef: sourceRef || undefined,
          data,
          createdBy: String(actor.id),
        });
        ctx.send(input.entity, `Recorded ${row.kind} ${row.id}.`);
        return;
      }
      if (sub === "compare") {
        const [
          runsText = "",
          questionsText = "",
          measuresText = "",
          interpretation = "",
          ...extra
        ] = fields(raw);
        const runIds = runsText
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        if (
          runIds.length < 2 ||
          runIds.some((id) => !deps.db.getSimulationRun(id)) ||
          !interpretation ||
          extra.length
        ) {
          ctx.send(input.entity, HELP);
          return;
        }
        const measures = parseObject(measuresText);
        if (!measures) {
          ctx.send(input.entity, "Measures must be a JSON object.");
          return;
        }
        // Runs and their events are already preserved append-only in their own
        // tables — the dataset references them instead of embedding full copies
        // (an embedded copy per comparison grows quadratically and drifts).
        const dataset = {
          schema: "marina.simulation.comparison.v2",
          runRefs: runIds.map((id) => ({
            run: id,
            eventCount: deps.db.listSimulationEvents(id).length,
          })),
        };
        const row = deps.db.createSimulationComparison({
          runIds,
          questions: questionsText
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          measures,
          interpretation,
          dataset,
          createdBy: String(actor.id),
        });
        ctx.send(
          input.entity,
          `Comparison dataset ${row.id} references ${runIds.length} runs without declaring a universal winner.`,
        );
        return;
      }
      if (sub === "show") {
        const row = deps.db.getSimulationRun(input.tokens[1] ?? "");
        if (!row) {
          ctx.send(input.entity, notFound("simulation run", "lab list"));
          return;
        }
        ctx.send(
          input.entity,
          `${row.id} · ${row.mode}/${row.reproducibility}\nManifest: ${row.manifest_hash}\nParent: ${row.parent_run_id ?? "none"}\nEvents: ${
            deps.db
              .listSimulationEvents(row.id)
              .map((e) => e.kind)
              .join(", ") || "none"
          }`,
        );
        return;
      }
      if (sub === "list" || !sub) {
        const rows = deps.db.listSimulationRuns();
        ctx.send(
          input.entity,
          rows.length
            ? rows.map((r) => `${r.id} · ${r.mode}/${r.reproducibility}`).join("\n")
            : "No simulation runs declared.",
        );
        return;
      }
      ctx.send(input.entity, HELP);
    },
  };
}
function fields(raw: string) {
  return raw.split("|").map((x) => x.trim());
}
function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  return undefined;
}
function isMode(v: string): v is SimulationMode {
  return MODES.includes(v as SimulationMode);
}
function isLevel(v: string): v is ReproducibilityLevel {
  return LEVELS.includes(v as ReproducibilityLevel);
}
function isEvent(v: string | undefined): v is SimulationEventRow["kind"] {
  return [
    "started",
    "intervention",
    "observation",
    "measure",
    "completed",
    "failed",
    "gap",
  ].includes(v ?? "");
}
