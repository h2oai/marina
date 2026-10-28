// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type ExerciseContext, exercises } from "./exercise";

export async function exerciseLineage(ctx: ExerciseContext) {
  const { check, value } = exercises(ctx);
  await check(
    "economy adapter qa-ledger | reference | local | reference",
    /adapter|recorded/i,
    ["economy adapter "],
    "SELECT id FROM economic_adapters WHERE id='qa-ledger'",
  );
  await check(
    'economy contract journey:qualification | {"deliverable":"checked report"} | independent review | recorded disagreement | qa-ledger',
    /contract|recorded/i,
    ["economy contract "],
    "SELECT id FROM economic_contracts WHERE goal_ref='journey:qualification'",
  );
  const contract = value(
    "SELECT id FROM economic_contracts WHERE goal_ref='journey:qualification'",
  );
  await check(
    `economy event ${contract} contribution | agent:CleanOwner | report:qa | | | | task:1 | {"checked":true}`,
    /recorded|event/i,
    ["economy event "],
    "SELECT id FROM economic_events WHERE kind='contribution'",
  );
  await check(`economy show ${contract}`, /independent review/, ["economy show "]);
  await check("economy list", /qualification|checked report/, ["economy list"]);

  await check(
    'lab manifest {"world":"empty","population":["agent:CleanOwner"],"links":["task:1"]}',
    /manifest/i,
    ["lab manifest "],
    "SELECT hash FROM simulation_manifests",
  );
  const manifest = value("SELECT hash FROM simulation_manifests ORDER BY created_at DESC LIMIT 1");
  await check(
    `lab run ${manifest} | recorded | recorded-response | qa-seed | {"memory":"private"}`,
    /run|recorded/i,
    ["lab run "],
    "SELECT id FROM simulation_runs WHERE seed='qa-seed'",
  );
  const run = value("SELECT id FROM simulation_runs WHERE seed='qa-seed'");
  await check(
    `lab event ${run} observation | task:1 | {"result":"checked"}`,
    /event|recorded/i,
    ["lab event "],
    "SELECT id FROM simulation_events WHERE kind='observation'",
  );
  await check(
    `lab fork ${run} | task:1 | {"memory":"shared"} | qa-fork`,
    /Counterfactual|fork|run/i,
    ["lab fork "],
    "SELECT id FROM simulation_runs WHERE seed='qa-fork'",
  );
  const fork = value("SELECT id FROM simulation_runs WHERE seed='qa-fork'");
  await check(
    `lab replicate ${manifest} | synthetic | statistical | 2 | qa-replicate`,
    /replicat|run/i,
    ["lab replicate "],
    "SELECT id FROM simulation_runs WHERE seed LIKE 'qa-replicate%'",
  );
  await check(
    `lab compare ${run},${fork} | is evidence retained | {"quality":"checked"} | fixture comparison only`,
    /comparison|recorded/i,
    ["lab compare "],
    "SELECT id FROM simulation_comparisons",
  );
  await check(`lab show ${run}`, /started, observation/, ["lab show "]);
  await check("lab list", /recorded\/recorded-response/, ["lab list"]);

  await check(
    "genome create empty | memory:private,model:qualification | protocol:v1 | qualification genome",
    /genome|sha256/i,
    ["genome create "],
    "SELECT hash FROM marina_genomes",
  );
  const genome = value("SELECT hash FROM marina_genomes ORDER BY created_at DESC LIMIT 1");
  await check(`genome show ${genome}`, /empty/, ["genome show "]);
  await check("genome list", new RegExp(genome), ["genome list"]);
  await check(
    'mutation record association qa-association | proposed | verify relation semantics | {"semantics":"reviewed"}',
    /mutation|recorded/i,
    ["mutation record "],
    "SELECT id FROM civilization_mutations WHERE target_ref='qa-association'",
  );
  const mutation = value("SELECT id FROM civilization_mutations WHERE target_ref='qa-association'");
  await check(`mutation show ${mutation}`, /verify relation semantics/, ["mutation show "]);
  await check("mutation lineage association qa-association", /verify relation semantics|proposed/, [
    "mutation lineage ",
  ]);
  await check(
    `mutation genome ${genome} | add qualification constraint | {"qualification":"required"}`,
    /mutation|genome/i,
    ["mutation genome "],
  );
  await check("mutation list", /qa-association/, ["mutation list "]);
  const parent = value("SELECT id FROM intellects WHERE display_name='qa-intellect'");
  await check(
    `reproduce intellect ${parent} | qa-reproduction | test continuity | [{"kind":"memory","ref":"pool:qa-pool","disposition":"inherited"}]`,
    /reproduc|created/i,
    ["reproduce intellect "],
    "SELECT id FROM cognitive_reproductions",
  );
  const reproduction = value(
    "SELECT id FROM cognitive_reproductions ORDER BY created_at DESC LIMIT 1",
  );
  await check(`reproduce show ${reproduction}`, /inherited memory:pool:qa-pool/, [
    "reproduce show ",
  ]);
  await check("reproduce list", new RegExp(reproduction), ["reproduce list"]);

  await check(
    "mesh create mesh:qa | Qualification mesh | charter:local | transparent.v1",
    /mesh|created/i,
    ["mesh create "],
    "SELECT id FROM meshes WHERE id='mesh:qa'",
  );
  await check(
    'mesh join mesh:qa | {"purpose":"qualification"}',
    /join|recorded/i,
    ["mesh join "],
    "SELECT id FROM mesh_membership_events WHERE mesh_id='mesh:qa' AND kind='joined'",
  );
  await check(
    'mesh publish mesh:qa | result | {"answer":437}',
    /publish|event/i,
    ["mesh publish "],
    "SELECT id FROM mesh_events WHERE mesh_id='mesh:qa' AND kind='result'",
  );
  const event = value("SELECT id FROM mesh_events WHERE mesh_id='mesh:qa' AND kind='result'");
  await check(
    `mesh witness mesh:qa ${event} witnessed`,
    /witness|recorded/i,
    ["mesh witness "],
    "SELECT id FROM mesh_witnesses WHERE observation='witnessed'",
  );
  await check(`mesh export mesh:qa ${event}`, /eyJ|mesh:/, ["mesh export "]);
  await check(
    "mesh create mesh:qa-target | Qualification target | charter:local | transparent.v1",
    /mesh|created/i,
    ["mesh create "],
  );
  await check(
    'mesh translate mesh:qa | mesh:qa-target | agent:CleanOwner | {"result":"result"}',
    /translat|recorded/i,
    ["mesh translate "],
    "SELECT id FROM mesh_translations",
  );
  await check("mesh show mesh:qa", /Qualification mesh/, ["mesh show "]);
  await check("mesh list", /Qualification mesh/, ["mesh list"]);
  await check(
    "mesh leave mesh:qa | qualification complete",
    /left|leave|recorded/i,
    ["mesh leave "],
    "SELECT id FROM mesh_membership_events WHERE mesh_id='mesh:qa' AND kind='left'",
  );

  const score = JSON.stringify({
    goal: "Verify arithmetic",
    steps: [
      { id: "calculate", instruction: "Compute 19 times 23", assignee: "CleanWorker", access: [] },
    ],
  });
  await check(`conduct validate -- ${score}`, /Valid/, ["conduct validate "]);
  await check(`conduct create qa-score -- ${score}`, /stored|created|Score/i, ["conduct create "]);
  await check("conduct show qa-score", /Verify arithmetic/, ["conduct show "]);
  await check("conduct json qa-score", /Compute 19 times 23/, ["conduct json "]);
  await check("conduct fork qa-score qa-score-fork", /fork|created|Score/i, ["conduct fork "]);
  await check("conduct list", /qa-score-fork/, ["conduct list"]);
  await check("conduct ran qa-score -- Checked 437", /recorded|run/i, ["conduct ran "]);
  await check(
    "conduct outcome qa-score 1 category=qualification -- Mechanically checked result",
    /recorded|outcome/i,
    ["conduct outcome "],
  );
  await check(
    "conduct track qa-score echoing/qa-score predict=0.8 category=qualification",
    /track|recorded/i,
    ["conduct track "],
  );
  await check("conduct learned qualification", /qualification|qa-score|learned|none/i, [
    "conduct learned ",
  ]);
  await check("conduct resolve CleanWorker", /CleanWorker/, ["conduct resolve "]);

  await check("experiment create qa-evolution arms A,B metric accuracy", /created/i, [
    "experiment create ",
  ]);
  await check(
    "evolve create qa-evolution | improve reproducible checking",
    /drafted|created|session/i,
    ["evolve create "],
    "SELECT id FROM evolution_sessions WHERE objective='improve reproducible checking'",
  );
  await check("evolve start qa-evolution", /start|active/i, ["evolve start "]);
  await check("evolve pause qa-evolution", /paused/i, ["evolve pause "]);
  await check("evolve resume qa-evolution", /resum|active/i, ["evolve resume "]);
  await check(
    "evolve propose qa-evolution | Explicit checks improve repeatability | role:qa-role",
    /propos|candidate|run/i,
    ["evolve propose "],
  );
  const trial = value("SELECT id FROM evolution_runs ORDER BY created_at DESC LIMIT 1");
  await check(
    `evolve evaluate qa-evolution ${trial} | fixture comparison shows no improvement`,
    /evaluat|recorded/i,
    ["evolve evaluate "],
  );
  await check(`evolve decide qa-evolution ${trial} inconclusive`, /inconclusive|decid/i, [
    "evolve decide ",
  ]);
  for (const sub of ["status", "analyze"])
    await check(`evolve ${sub} qa-evolution`, /qa-evolution|inconclusive/, [`evolve ${sub} `]);
  await check("evolve complete qa-evolution", /complet/i, ["evolve complete "]);
  await check("evolve sessions", /qa-evolution/, ["evolve sessions"]);
}
