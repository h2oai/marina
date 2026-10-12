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
