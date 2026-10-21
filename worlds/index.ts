// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Static registry of every builtin world, so a compiled `marina` binary can
 * load worlds without a `worlds/` directory on disk. `loadWorld` resolves
 * builtin slugs through this map; `listAvailableWorlds` lists its keys.
 */
import type { WorldDefinition } from "../src/world/world-definition";
import commons from "./commons";
import craft from "./craft";
import dataInvestigation from "./data-investigation";
import deepResearch from "./deep-research";
import defaultWorld from "./default";
import demos from "./demos";
import dueDiligence from "./due-diligence";
import empty from "./empty";
import evolve from "./evolve";
import markets from "./markets";
import personal from "./personal";
import predictionLab from "./prediction-lab";
import redTeam from "./red-team";
import research from "./research";
import showcase from "./showcase";

export const BUILTIN_WORLDS: Record<string, WorldDefinition> = {
  commons,
  craft,
  "data-investigation": dataInvestigation,
  "deep-research": deepResearch,
  default: defaultWorld,
  demos,
  "due-diligence": dueDiligence,
  empty,
  evolve,
  markets,
  personal,
  "prediction-lab": predictionLab,
  "red-team": redTeam,
  research,
  showcase,
};

export const BUILTIN_WORLD_SLUGS: readonly string[] = Object.keys(BUILTIN_WORLDS);

/**
 * One line per builtin world, for hosts choosing a world without loading it
 * (`marina worlds --json`). Kept beside the registry; a test fails when a slug
 * has no summary.
 */
export const BUILTIN_WORLD_SUMMARIES: Record<string, string> = {
  commons: "Multi-agent coordination: themed rooms, exploration/research/curation projects, tasks",
  craft: "Spec-driven development: interview, spec, verify and ship with a review holdout",
  "data-investigation": "Root-cause one data anomaly: profile, hypothesize, reproduce, report",
  "deep-research": "Produce one evidence-backed research brief with confidence and limitations",
  default:
    "Intent-first workbench: a few focused rooms and an outcome/evidence/constraints contract",
  demos: "Interactive demonstrations: lobby, workshop and bridge rooms for guided tours",
  "due-diligence":
    "Company diligence: parallel workstreams to a sourced decision memo and risk register",
  empty: "Minimal: a single room and nothing else",
  evolve: "Capability benchmarks: eight benchmark objectives for agents to improve against",
  markets: "Prediction markets: live Kalshi/Polymarket feed rooms and binary market rooms",
  personal: "Self-improving agent: focused rooms with self-improvement objectives",
  "prediction-lab":
    "Calibration sprint: the markets world plus forecasting agents and a forecast channel",
  "red-team": "Adversarial review: stress-test a plan through structured challenge and rebuttal",
  research: "Research lab: evidence-first investigation, experiments and synthesis",
  showcase: "Full capability showcase: every room template, seeded projects, crews and benchmarks",
};

/**
 * What each builtin world is for, honestly: `core` worlds back real use
 * (`default` is the live Workbench, `empty` the minimal base for tests and
 * hosts); every other builtin is a `demo` — showcase material that no
 * production deployment selects. See docs/reference/feature-status.md.
 */
export const BUILTIN_WORLD_STATUS: Record<string, "core" | "demo"> = Object.fromEntries(
  Object.keys(BUILTIN_WORLDS).map((slug) => [
    slug,
    slug === "default" || slug === "empty" ? "core" : "demo",
  ]),
);
