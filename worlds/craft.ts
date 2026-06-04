/**
 * Craft Rooms — spec-driven development workflows as portable Marina rooms.
 *
 * Inspired by JoyCraft (maksutovic/joycraft): interview → spec → implement → verify → ship.
 * All intelligence lives in room commands + store + pools. No engine changes.
 *
 * Two rooms:
 *   craft/workshop  — interview, spec, implement, discover, ship (the work room)
 *   craft/review    — verify, scenario, verdict (holdout wall — restricted entry)
 *
 * Any world can import these:
 *
 *   import { craftRooms } from "./craft";
 *   const world: WorldDefinition = {
 *     rooms: { ...craftRooms(), ...otherRooms },
 *     ...
 *   };
 *
 * Or use as a standalone world:
 *
 *   MARINA_WORLD=craft bun run start
 *
 * Gateway paradigm: bridge two instances on the "craft" channel.
 * Workshop on instance A, review on instance B — true holdout wall
 * with network-level separation of concerns.
 */

import { join } from "node:path";
import type { MarinaDB } from "../src/persistence/database";
import { seedTraitsAndRoles } from "./seed";
import type {
  CommandContext,
  CommandHandler,
  CommandInput,
  Entity,
  EntityId,
  RoomContext,
  RoomId,
  RoomModule,
} from "../src/types";
import type { WorldDefinition } from "../src/world/world-definition";

// ─── ANSI ───────────────────────────────────────────────────────────────────

const D = "\x1b[2m";
const B = "\x1b[1m";
const C = "\x1b[36m";
const Y = "\x1b[33m";
const G = "\x1b[32m";
const R = "\x1b[0m";
const RED = "\x1b[31m";
const M = "\x1b[35m";

// ─── Types ──────────────────────────────────────────────────────────────────

interface AtomicSpec {
  id: string;
  title: string;
  what: string;
  why: string;
  criteria: string[];
  files: string[];
  edges: string[];
  status: "draft" | "ready" | "active" | "review" | "done" | "rejected";
  createdBy: string;
  createdAt: number;
}

interface InterviewState {
  step: number;
  answers: Record<string, string>;
  startedAt: number;
}

interface Verdict {
  specId: string;
  pass: boolean;
  reason: string;
  reviewer: string;
  reviewedAt: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const INTERVIEW_QUESTIONS = [
  { key: "problem", prompt: "What problem are you solving? (one paragraph)" },
  { key: "done", prompt: "What does done look like? (acceptance criteria)" },
  { key: "constraints", prompt: "What constraints exist? (tech, time, scope)" },
  { key: "files", prompt: "What files/modules are affected? (paths)" },
  { key: "edges", prompt: "What edge cases should we handle? (scenarios)" },
];

const KNOWLEDGE_POOLS = [
  "production-map",
  "dangerous-assumptions",
  "decision-log",
  "institutional-knowledge",
  "troubleshooting",
] as const;

/** Signal words → pool routing for discovery classification. */
const POOL_SIGNALS: Record<string, (typeof KNOWLEDGE_POOLS)[number]> = {
  deploy: "production-map",
  prod: "production-map",
  infra: "production-map",
  server: "production-map",
  host: "production-map",
  assume: "dangerous-assumptions",
  thought: "dangerous-assumptions",
  expect: "dangerous-assumptions",
  surprise: "dangerous-assumptions",
  wrong: "dangerous-assumptions",
  decide: "decision-log",
  chose: "decision-log",
  tradeoff: "decision-log",
  why: "decision-log",
  instead: "decision-log",
  pattern: "institutional-knowledge",
  convention: "institutional-knowledge",
  always: "institutional-knowledge",
  never: "institutional-knowledge",
  rule: "institutional-knowledge",
  fix: "troubleshooting",
  error: "troubleshooting",
  bug: "troubleshooting",
  broke: "troubleshooting",
  workaround: "troubleshooting",
};

const TUNE_DIMENSIONS = [
  "spec_quality",
  "granularity",
  "boundaries",
  "knowledge_capture",
  "testing",
  "discovery_flow",
  "session_discipline",
] as const;

const CRAFT_CHANNEL = "craft";

// ─── Helpers ────────────────────────────────────────────────────────────────

function nextSpecId(ctx: RoomContext): string {
  const counter = (ctx.store.get<number>("spec_counter") ?? 0) + 1;
  ctx.store.set("spec_counter", counter);
  return `spec-${counter}`;
}

function getSpecs(ctx: RoomContext): AtomicSpec[] {
  return ctx.store.get<AtomicSpec[]>("specs") ?? [];
}

function setSpecs(ctx: RoomContext, specs: AtomicSpec[]): void {
  ctx.store.set("specs", specs);
}

function getSpec(ctx: RoomContext, id: string): AtomicSpec | undefined {
  return getSpecs(ctx).find((s) => s.id === id);
}

function updateSpec(ctx: RoomContext, id: string, patch: Partial<AtomicSpec>): boolean {
  const specs = getSpecs(ctx);
  const idx = specs.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  specs[idx] = { ...specs[idx]!, ...patch };
  setSpecs(ctx, specs);
  return true;
}

function getInterview(ctx: RoomContext, entity: EntityId): InterviewState | undefined {
  return ctx.store.get<InterviewState>(`interview:${entity}`);
}

function setInterview(ctx: RoomContext, entity: EntityId, state: InterviewState): void {
  ctx.store.set(`interview:${entity}`, state);
}

function classifyFact(text: string): (typeof KNOWLEDGE_POOLS)[number] {
  const lower = text.toLowerCase();
  for (const [signal, pool] of Object.entries(POOL_SIGNALS)) {
    if (lower.includes(signal)) return pool;
  }
  return "institutional-knowledge";
}

function formatSpec(spec: AtomicSpec): string {
  const lines = [
    `${B}${C}[${spec.id}]${R} ${B}${spec.title}${R}  ${D}(${spec.status})${R}`,
    "",
    `${B}What:${R} ${spec.what}`,
    `${B}Why:${R} ${spec.why}`,
  ];
  if (spec.criteria.length) {
    lines.push(`${B}Criteria:${R}`);
    for (const c of spec.criteria) lines.push(`  ${G}☐${R} ${c}`);
  }
  if (spec.files.length) {
    lines.push(`${B}Files:${R} ${spec.files.join(", ")}`);
  }
  if (spec.edges.length) {
    lines.push(`${B}Edge cases:${R}`);
    for (const e of spec.edges) lines.push(`  ${Y}⚠${R} ${e}`);
  }
  lines.push(`${D}Created by ${spec.createdBy} at ${new Date(spec.createdAt).toISOString()}${R}`);
  return lines.join("\n");
}

function craftBanner(): string {
  return `${C}╭──────────────────────────────────────╮
│        ◆  Craft Workshop  ◆         │
│   Interview → Spec → Ship           │
╰──────────────────────────────────────╯${R}`;
}

function reviewBanner(): string {
  return `${M}╭──────────────────────────────────────╮
│        ◇  Craft Review  ◇           │
│   Verify → Scenario → Verdict       │
╰──────────────────────────────────────╯${R}`;
}

// ─── Workshop Commands ──────────────────────────────────────────────────────

const workshopHelp: CommandHandler = (ctx, input) => {
  ctx.send(
    input.entity,
    [
      `${B}Craft Workshop — Commands${R}`,
      "",
      `  ${Y}interview start${R}     ${D}Begin structured intent capture${R}`,
      `  ${Y}interview <answer>${R}  ${D}Answer the current question${R}`,
      `  ${Y}interview done${R}      ${D}Finish interview, generate brief${R}`,
      `  ${Y}spec create <title>${R} ${D}Create an atomic spec from interview${R}`,
      `  ${Y}spec list${R}           ${D}List all specs${R}`,
      `  ${Y}spec show <id>${R}      ${D}Show spec details${R}`,
      `  ${Y}implement <id>${R}      ${D}Start implementing a spec${R}`,
      `  ${Y}discover <fact>${R}     ${D}Capture and route a discovery${R}`,
      `  ${Y}ship <id>${R}           ${D}Mark spec done, capture discoveries${R}`,
      `  ${Y}tune${R}                ${D}Assess project maturity (7 dimensions)${R}`,
      `  ${Y}status${R}              ${D}Current craft state${R}`,
      `  ${Y}help${R}                ${D}This message${R}`,
      "",
      `${D}All standard Marina commands also work.${R}`,
    ].join("\n"),
  );
};

const workshopInterview: CommandHandler = (ctx, input) => {
  const sub = input.args.trim();

  if (sub === "start" || (!sub && !getInterview(ctx, input.entity))) {
    setInterview(ctx, input.entity, { step: 0, answers: {}, startedAt: Date.now() });
    const q = INTERVIEW_QUESTIONS[0]!;
    ctx.send(
      input.entity,
      `${G}Interview started.${R}\n\n${B}Q1/${INTERVIEW_QUESTIONS.length}:${R} ${q.prompt}`,
    );
    return;
  }

  if (sub === "done") {
    const iv = getInterview(ctx, input.entity);
    if (!iv || Object.keys(iv.answers).length === 0) {
      ctx.send(input.entity, `${RED}No interview in progress. Use 'interview start'.${R}`);
      return;
    }
    const brief = Object.entries(iv.answers)
      .map(([k, v]) => `${B}${k}:${R} ${v}`)
      .join("\n");
    ctx.store.set(`brief:${input.entity}`, iv.answers);
    ctx.store.delete(`interview:${input.entity}`);
    ctx.send(
      input.entity,
      `${G}Interview complete.${R} Feature brief:\n\n${brief}\n\n${D}Use 'spec create <title>' to decompose into atomic specs.${R}`,
    );

    // Broadcast to craft channel if available
    if (ctx.channels) {
      const entity = ctx.getEntity(input.entity);
      const name = entity?.name ?? "unknown";
      ctx.channels.send(
        CRAFT_CHANNEL,
        input.entity,
        name,
        `Interview complete — brief ready for decomposition`,
      );
    }
    return;
  }

  // Answering current question
  const iv = getInterview(ctx, input.entity);
  if (!iv) {
    ctx.send(input.entity, `${D}No interview in progress. Use 'interview start'.${R}`);
    return;
  }

  if (!sub) {
    const q = INTERVIEW_QUESTIONS[iv.step]!;
    ctx.send(input.entity, `${B}Q${iv.step + 1}/${INTERVIEW_QUESTIONS.length}:${R} ${q.prompt}`);
    return;
  }

  const q = INTERVIEW_QUESTIONS[iv.step]!;
  iv.answers[q.key] = sub;
  iv.step++;
  setInterview(ctx, input.entity, iv);

  if (iv.step >= INTERVIEW_QUESTIONS.length) {
    ctx.send(
      input.entity,
      `${G}All questions answered.${R} Use ${Y}interview done${R} to generate brief, or answer any question again.`,
    );
  } else {
    const next = INTERVIEW_QUESTIONS[iv.step]!;
    ctx.send(
      input.entity,
      `${G}✓${R} Captured.\n\n${B}Q${iv.step + 1}/${INTERVIEW_QUESTIONS.length}:${R} ${next.prompt}`,
    );
  }
};

const workshopSpec: CommandHandler = (ctx, input) => {
  const tokens = input.args.trim().split(/\s+/);
  const sub = tokens[0] ?? "list";
  const rest = tokens.slice(1).join(" ");

  if (sub === "create") {
    if (!rest) {
      ctx.send(input.entity, `${RED}Usage: spec create <title>${R}`);
      return;
    }
    const brief = ctx.store.get<Record<string, string>>(`brief:${input.entity}`);
    const entity = ctx.getEntity(input.entity);
    const spec: AtomicSpec = {
      id: nextSpecId(ctx),
      title: rest,
      what: brief?.problem ?? "(fill in from interview or manually)",
      why: brief?.done ?? "(acceptance criteria from interview)",
      criteria: brief?.done ? brief.done.split(/[,;]\s*/).filter(Boolean) : [],
      files: brief?.files ? brief.files.split(/[,;\s]+/).filter(Boolean) : [],
      edges: brief?.edges ? brief.edges.split(/[,;]\s*/).filter(Boolean) : [],
      status: "draft",
      createdBy: entity?.name ?? "unknown",
      createdAt: Date.now(),
    };
    const specs = getSpecs(ctx);
    specs.push(spec);
    setSpecs(ctx, specs);
    ctx.send(
      input.entity,
      `${G}Created:${R}\n\n${formatSpec(spec)}\n\n${D}Edit fields, then 'implement ${spec.id}' when ready.${R}`,
    );
    return;
  }

  if (sub === "list") {
    const specs = getSpecs(ctx);
    if (!specs.length) {
      ctx.send(input.entity, `${D}No specs yet. Run an interview, then 'spec create <title>'.${R}`);
      return;
    }
    const lines = specs.map((s) => `  ${C}${s.id}${R} ${s.title} ${D}(${s.status})${R}`);
    ctx.send(input.entity, `${B}Specs:${R}\n${lines.join("\n")}`);
    return;
  }

  if (sub === "show") {
    const spec = getSpec(ctx, rest);
    if (!spec) {
      ctx.send(input.entity, `${RED}Spec not found: ${rest}${R}`);
      return;
    }
    ctx.send(input.entity, formatSpec(spec));
    return;
  }

  // Direct spec ID — show it
  const spec = getSpec(ctx, sub);
  if (spec) {
    ctx.send(input.entity, formatSpec(spec));
    return;
  }

  ctx.send(input.entity, `${D}Usage: spec [create|list|show] [id]${R}`);
};

const workshopImplement: CommandHandler = (ctx, input) => {
  const specId = input.args.trim();
  if (!specId) {
    ctx.send(input.entity, `${RED}Usage: implement <spec-id>${R}`);
    return;
  }
  const spec = getSpec(ctx, specId);
  if (!spec) {
    ctx.send(input.entity, `${RED}Spec not found: ${specId}${R}`);
    return;
  }
  if (spec.status !== "draft" && spec.status !== "ready") {
    ctx.send(
      input.entity,
      `${RED}Spec ${specId} is ${spec.status} — can only implement draft/ready specs.${R}`,
    );
    return;
  }
  updateSpec(ctx, specId, { status: "active" });
  ctx.send(
    input.entity,
    [
      `${G}Implementation started:${R} ${B}${spec.title}${R}`,
      "",
      `${B}What:${R} ${spec.what}`,
      `${B}Files:${R} ${spec.files.join(", ") || "(none specified)"}`,
      "",
      `${B}Acceptance criteria:${R}`,
      ...spec.criteria.map((c) => `  ${Y}☐${R} ${c}`),
      "",
      `${D}Use 'discover <fact>' to capture findings.${R}`,
      `${D}Use 'ship ${specId}' when done.${R}`,
    ].join("\n"),
  );

  if (ctx.channels) {
    const entity = ctx.getEntity(input.entity);
    ctx.channels.send(
      CRAFT_CHANNEL,
      input.entity,
      entity?.name ?? "unknown",
      `Started implementing ${specId}: ${spec.title}`,
    );
  }
};

const workshopDiscover: CommandHandler = (ctx, input) => {
  const fact = input.args.trim();
  if (!fact) {
    ctx.send(input.entity, `${RED}Usage: discover <fact or finding>${R}`);
    return;
  }
  const pool = classifyFact(fact);
  const discoveries = ctx.store.get<string[]>("discoveries") ?? [];
  discoveries.push(`[${pool}] ${fact}`);
  ctx.store.set("discoveries", discoveries);

  // Route to pool if CommandContext is available
  const cctx = ctx as CommandContext;
  if (cctx.pool) {
    try {
      cctx.pool.add(pool, fact, 7);
      ctx.send(input.entity, `${G}✓${R} Routed to ${C}${pool}${R} pool.\n${D}${fact}${R}`);
      return;
    } catch {
      // Fall back to store-only
    }
  }

  ctx.send(
    input.entity,
    `${G}✓${R} Classified → ${C}${pool}${R} ${D}(stored locally, pool unavailable)${R}\n${D}${fact}${R}`,
  );
};

const workshopShip: CommandHandler = (ctx, input) => {
  const specId = input.args.trim();
  if (!specId) {
    ctx.send(input.entity, `${RED}Usage: ship <spec-id>${R}`);
    return;
  }
  const spec = getSpec(ctx, specId);
  if (!spec) {
    ctx.send(input.entity, `${RED}Spec not found: ${specId}${R}`);
    return;
  }
  if (spec.status !== "active" && spec.status !== "review") {
    ctx.send(
      input.entity,
      `${RED}Spec ${specId} is ${spec.status} — can only ship active/review specs.${R}`,
    );
    return;
  }

  updateSpec(ctx, specId, { status: "done" });
  const discoveries = ctx.store.get<string[]>("discoveries") ?? [];

  const lines = [`${G}✓ Shipped:${R} ${B}${spec.title}${R}`, ""];

  if (discoveries.length) {
    lines.push(`${B}Session discoveries (${discoveries.length}):${R}`);
    for (const d of discoveries) lines.push(`  ${D}${d}${R}`);
    lines.push("");
    // Clear discoveries for next session
    ctx.store.set("discoveries", []);
  }

  // Notify review room via channel
  if (ctx.channels) {
    const entity = ctx.getEntity(input.entity);
    ctx.channels.send(
      CRAFT_CHANNEL,
      input.entity,
      entity?.name ?? "unknown",
      `Shipped ${specId}: ${spec.title} — ready for review`,
    );
  }

  lines.push(`${D}Spec moved to 'done'. Review room can verify independently.${R}`);
  ctx.send(input.entity, lines.join("\n"));
};

const workshopTune: CommandHandler = (ctx, input) => {
  const specs = getSpecs(ctx);
  const discoveries = ctx.store.get<string[]>("discoveries") ?? [];
  const briefs = ctx.store.keys().filter((k) => k.startsWith("brief:")).length;

  const scores: Record<string, { score: number; max: number; hint: string }> = {
    spec_quality: {
      score: specs.filter((s) => s.criteria.length >= 2 && s.what.length > 20).length,
      max: Math.max(specs.length, 1),
      hint: "Specs with ≥2 criteria and detailed 'what'",
    },
    granularity: {
      score: specs.filter((s) => s.files.length <= 5).length,
      max: Math.max(specs.length, 1),
      hint: "Specs touching ≤5 files (atomic)",
    },
    boundaries: {
      score: specs.filter((s) => s.edges.length >= 1).length,
      max: Math.max(specs.length, 1),
      hint: "Specs with edge cases documented",
    },
    knowledge_capture: {
      score: Math.min(discoveries.length, 10),
      max: 10,
      hint: "Discoveries captured via 'discover'",
    },
    testing: {
      score: specs.filter((s) => s.status === "done" || s.status === "review").length,
      max: Math.max(specs.length, 1),
      hint: "Specs that reached review/done",
    },
    discovery_flow: {
      score: Math.min(briefs, 3),
      max: 3,
      hint: "Completed interview → brief cycles",
    },
    session_discipline: {
      score: specs.filter((s) => s.status !== "draft").length,
      max: Math.max(specs.length, 1),
      hint: "Specs that moved past draft",
    },
  };

  const lines = [`${B}${C}Tune Assessment${R}`, ""];
  let totalScore = 0;
  let totalMax = 0;
  for (const [dim, { score, max, hint }] of Object.entries(scores)) {
    const pct = max > 0 ? Math.round((score / max) * 100) : 0;
    const bar = pct >= 80 ? G : pct >= 40 ? Y : RED;
    totalScore += score;
    totalMax += max;
    lines.push(
      `  ${bar}${pct.toString().padStart(3)}%${R} ${B}${dim}${R} ${D}(${score}/${max}) ${hint}${R}`,
    );
  }
  const overall = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
  lines.push("", `  ${B}Overall: ${overall}%${R}`);

  const level =
    overall >= 80
      ? "Level 5 — Software Factory"
      : overall >= 60
        ? "Level 4 — Developer as PM"
        : overall >= 40
          ? "Level 3 — Developer as Manager"
          : overall >= 20
            ? "Level 2 — Junior Developer"
            : "Level 1 — Autocomplete";
  lines.push(`  ${C}${level}${R}`);

  ctx.send(input.entity, lines.join("\n"));
};

const workshopStatus: CommandHandler = (ctx, input) => {
  const specs = getSpecs(ctx);
  const iv = getInterview(ctx, input.entity);
  const discoveries = ctx.store.get<string[]>("discoveries") ?? [];

  const lines = [`${B}Craft Workshop Status${R}`, ""];

  if (iv) {
    lines.push(`${Y}Interview in progress${R} — Q${iv.step + 1}/${INTERVIEW_QUESTIONS.length}`);
    lines.push("");
  }

  const byStatus: Record<string, number> = {};
  for (const s of specs) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  if (specs.length) {
    lines.push(`${B}Specs:${R} ${specs.length} total`);
    for (const [status, count] of Object.entries(byStatus)) {
      lines.push(`  ${D}${status}: ${count}${R}`);
    }
  } else {
    lines.push(`${D}No specs yet.${R}`);
  }

  if (discoveries.length) {
    lines.push(`${B}Discoveries:${R} ${discoveries.length} pending`);
  }

  lines.push("", `${D}Use 'help' for available commands.${R}`);
  ctx.send(input.entity, lines.join("\n"));
};

// ─── Review Commands ────────────────────────────────────────────────────────

const reviewHelp: CommandHandler = (ctx, input) => {
  ctx.send(
    input.entity,
    [
      `${B}Craft Review — Commands${R}`,
      "",
      `  ${Y}review <spec-id>${R}             ${D}Pull spec for independent review${R}`,
      `  ${Y}scenario <spec-id> <test>${R}     ${D}Add a behavioral test scenario${R}`,
      `  ${Y}verdict <spec-id> pass|fail${R}   ${D}Approve or reject with reason${R}`,
      `  ${Y}status${R}                        ${D}Show pending reviews${R}`,
      `  ${Y}help${R}                          ${D}This message${R}`,
      "",
      `${D}This is the holdout wall. Implementation details are not visible here.${R}`,
      `${D}Review against the spec only. All standard commands also work.${R}`,
    ].join("\n"),
  );
};

const reviewReview: CommandHandler = (ctx, input) => {
  const specId = input.args.trim();
  if (!specId) {
    ctx.send(input.entity, `${RED}Usage: review <spec-id>${R}`);
    return;
  }
  // Pull spec from shared store (review room reads workshop store via channel)
  // In single-instance mode, specs are shared via the craft channel
  const spec = getSpec(ctx, specId);
  if (!spec) {
    ctx.send(
      input.entity,
      `${RED}Spec ${specId} not found in review store.${R}\n${D}Specs arrive via the 'craft' channel from the workshop.${R}`,
    );
    return;
  }
  ctx.send(
    input.entity,
    `${M}Review:${R}\n\n${formatSpec(spec)}\n\n${D}Use 'scenario ${specId} <test>' or 'verdict ${specId} pass|fail <reason>'.${R}`,
  );
};

const reviewScenario: CommandHandler = (ctx, input) => {
  const tokens = input.args.trim().split(/\s+/);
  const specId = tokens[0];
  const test = tokens.slice(1).join(" ");
  if (!specId || !test) {
    ctx.send(input.entity, `${RED}Usage: scenario <spec-id> <test description>${R}`);
    return;
  }
  const scenarios = ctx.store.get<string[]>(`scenarios:${specId}`) ?? [];
  scenarios.push(test);
  ctx.store.set(`scenarios:${specId}`, scenarios);
  ctx.send(input.entity, `${G}✓${R} Scenario ${scenarios.length} for ${C}${specId}${R}: ${test}`);
};

const reviewVerdict: CommandHandler = (ctx, input) => {
  const tokens = input.args.trim().split(/\s+/);
  const specId = tokens[0];
  const pass = tokens[1]?.toLowerCase();
  const reason = tokens.slice(2).join(" ");
  if (!specId || (pass !== "pass" && pass !== "fail")) {
    ctx.send(input.entity, `${RED}Usage: verdict <spec-id> pass|fail <reason>${R}`);
    return;
  }
  const entity = ctx.getEntity(input.entity);
  const verdict: Verdict = {
    specId,
    pass: pass === "pass",
    reason: reason || "(no reason given)",
    reviewer: entity?.name ?? "unknown",
    reviewedAt: Date.now(),
  };
  const verdicts = ctx.store.get<Verdict[]>("verdicts") ?? [];
  verdicts.push(verdict);
  ctx.store.set("verdicts", verdicts);

  const icon = verdict.pass ? `${G}✓ PASS${R}` : `${RED}✗ FAIL${R}`;
  ctx.send(input.entity, `${icon} ${C}${specId}${R}: ${verdict.reason}`);

  // Notify workshop via channel
  if (ctx.channels) {
    ctx.channels.send(
      CRAFT_CHANNEL,
      input.entity,
      entity?.name ?? "unknown",
      `Verdict on ${specId}: ${pass.toUpperCase()} — ${verdict.reason}`,
    );
  }
};

const reviewStatus: CommandHandler = (ctx, input) => {
  const verdicts = ctx.store.get<Verdict[]>("verdicts") ?? [];
  const scenarioKeys = ctx.store.keys().filter((k) => k.startsWith("scenarios:"));
  const specKeys = ctx.store.keys().filter((k) => k.startsWith("spec-"));

  const lines = [`${B}Craft Review Status${R}`, ""];

  if (verdicts.length) {
    lines.push(`${B}Verdicts:${R}`);
    for (const v of verdicts) {
      const icon = v.pass ? G + "✓" + R : RED + "✗" + R;
      lines.push(`  ${icon} ${C}${v.specId}${R} by ${v.reviewer}: ${v.reason}`);
    }
  } else {
    lines.push(`${D}No verdicts yet.${R}`);
  }

  if (scenarioKeys.length) {
    lines.push(`${B}Scenarios:${R} ${scenarioKeys.length} spec(s) with test scenarios`);
  }

  lines.push("", `${D}Use 'help' for available commands.${R}`);
  ctx.send(input.entity, lines.join("\n"));
};

// ─── Room Builders ──────────────────────────────────────────────────────────

/** Build the craft workshop room. Interview → spec → implement → ship. */
export function workshopRoom(): RoomModule {
  return {
    short: "Craft Workshop",
    long: (ctx) => {
      const specs = getSpecs(ctx);
      const active = specs.filter((s) => s.status === "active").length;
      const done = specs.filter((s) => s.status === "done").length;
      return [
        craftBanner(),
        "",
        "A spec-driven development workshop. Interview your intent,",
        "decompose into atomic specs, implement with discipline, ship with confidence.",
        "",
        `${D}Specs: ${specs.length} total, ${active} active, ${done} done${R}`,
        `${D}Type 'help' for commands.${R}`,
      ].join("\n");
    },
    items: {
      "how it works":
        "Craft Workshop: structured interview captures intent, " +
        "atomic specs decompose it into testable units, " +
        "implementation tracks against acceptance criteria, " +
        "discoveries are classified and routed to knowledge pools. " +
        "Ship when done — the review room verifies independently.",
      "the workflow":
        "interview start → answer questions → interview done → " +
        "spec create <title> → implement <id> → discover <facts> → ship <id>. " +
        "The review room on another instance can verify via the 'craft' channel.",
      "knowledge pools":
        "Five knowledge pools: production-map, dangerous-assumptions, " +
        "decision-log, institutional-knowledge, troubleshooting. " +
        "Use 'discover <fact>' to auto-classify and route.",
    },
    exits: {
      review: "craft/review" as RoomId,
    },
    commands: {
      help: workshopHelp,
      interview: workshopInterview,
      spec: workshopSpec,
      implement: workshopImplement,
      discover: workshopDiscover,
      ship: workshopShip,
      tune: workshopTune,
      status: workshopStatus,
    },
    onEnter(ctx, entity) {
      const ent = ctx.getEntity(entity);
      if (!ent || ent.kind !== "agent") return;
      ctx.send(entity, craftBanner());
      ctx.send(
        entity,
        `${D}Type ${Y}help${R}${D} for craft commands. 'interview start' to begin.${R}`,
      );
    },
    onTick(ctx) {
      // Nudge stalled interviews (no activity for 3+ ticks)
      for (const entity of ctx.entities) {
        if (entity.kind !== "agent") continue;
        const iv = getInterview(ctx, entity.id);
        if (!iv) continue;
        const stallKey = `stall:${entity.id}`;
        const stallCount = (ctx.store.get<number>(stallKey) ?? 0) + 1;
        ctx.store.set(stallKey, stallCount);
        if (stallCount === 3) {
          const q = INTERVIEW_QUESTIONS[iv.step];
          if (q) {
            ctx.send(entity.id, `${D}Still waiting on: ${q.prompt}${R}`);
          }
          ctx.store.set(stallKey, 0);
        }
      }

      // Listen for specs arriving via craft channel (from remote workshop via gateway)
      if (ctx.channels && !ctx.store.get<boolean>("channel_listening")) {
        ctx.store.set("channel_listening", true);
        ctx.channels.onMessage(CRAFT_CHANNEL, (_sid, senderName, content) => {
          // Broadcast channel traffic to all entities in the room
          ctx.broadcast(`${D}[craft] ${senderName}: ${content}${R}`, "craft_channel");
        });
      }
    },
  };
}

/** Build the craft review room. Holdout wall — independent verification. */
export function reviewRoom(): RoomModule {
  return {
    short: "Craft Review",
    long: (ctx) => {
      const verdicts = ctx.store.get<Verdict[]>("verdicts") ?? [];
      const passed = verdicts.filter((v) => v.pass).length;
      const failed = verdicts.filter((v) => !v.pass).length;
      return [
        reviewBanner(),
        "",
        "The holdout wall. Reviewers verify specs independently,",
        "without seeing implementation details. Only the spec and",
        "acceptance criteria are visible. Scenarios written here",
        "are never shared with the workshop.",
        "",
        `${D}Verdicts: ${passed} passed, ${failed} failed${R}`,
        `${D}Type 'help' for commands.${R}`,
      ].join("\n");
    },
    items: {
      "the holdout wall":
        "This room exists to verify work independently. " +
        "The reviewer writes behavioral test scenarios from the spec alone, " +
        "then issues a pass/fail verdict. Implementation code never enters this room. " +
        "On separate Marina instances connected via gateway, " +
        "this is true network-level isolation.",
      "how verdicts work":
        "Use 'review <spec-id>' to see a spec, " +
        "'scenario <spec-id> <test>' to add test scenarios, " +
        "'verdict <spec-id> pass|fail <reason>' to approve or reject. " +
        "Verdicts are broadcast on the 'craft' channel.",
    },
    exits: {
      workshop: "craft/workshop" as RoomId,
    },
    commands: {
      help: reviewHelp,
      review: reviewReview,
      scenario: reviewScenario,
      verdict: reviewVerdict,
      status: reviewStatus,
    },
    onEnter(ctx, entity) {
      const ent = ctx.getEntity(entity);
      if (!ent || ent.kind !== "agent") return;
      ctx.send(entity, reviewBanner());
      ctx.send(entity, `${D}Type ${Y}help${R}${D} for review commands.${R}`);
    },
    onTick(ctx) {
      // Listen for specs/ship notifications from workshop via craft channel
      if (ctx.channels && !ctx.store.get<boolean>("channel_listening")) {
        ctx.store.set("channel_listening", true);
        ctx.channels.onMessage(CRAFT_CHANNEL, (senderId, senderName, content) => {
          ctx.broadcast(`${D}[craft] ${senderName}: ${content}${R}`, "craft_channel");

          // Auto-import spec data when shipped
          if (content.includes("Shipped") && content.includes("spec-")) {
            const match = content.match(/spec-\d+/);
            if (match) {
              ctx.broadcast(
                `${Y}New spec ready for review:${R} ${C}${match[0]}${R}`,
                "craft_notify",
              );
            }
          }
        });
      }
    },
  };
}

/**
 * Build all craft rooms as a Record suitable for WorldDefinition.rooms.
 *
 *   import { craftRooms } from "./craft";
 *   const world: WorldDefinition = { rooms: { ...craftRooms(), ...otherRooms }, ... };
 */
// Individual room module exports for composition
export const craftWorkshop = workshopRoom();
export const craftReview = reviewRoom();

export function craftRooms(): Record<string, RoomModule> {
  return {
    "craft/workshop": workshopRoom(),
    "craft/review": reviewRoom(),
  };
}

// ─── Guide Notes ────────────────────────────────────────────────────────────

const GUIDE_NOTES: WorldDefinition["guideNotes"] = [
  {
    content:
      "Welcome to Craft — spec-driven development as a live system. " +
      "Two rooms: craft/workshop (interview → spec → implement → ship) " +
      "and craft/review (independent verification — the holdout wall). " +
      "Type 'goto craft/workshop' to begin.",
    importance: 10,
    type: "skill",
  },
  {
    content:
      "The workflow: interview start → answer questions → interview done → " +
      "spec create <title> → implement <id> → discover <facts> → ship <id>. " +
      "Each step is a room command. State persists in the room store.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "Atomic specs are self-contained task documents: what, why, acceptance criteria, " +
      "affected files, edge cases. Create them from interview briefs or manually. " +
      "A good spec takes 15 seconds to understand and has testable criteria.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "The 'discover' command auto-classifies facts into 5 knowledge pools: " +
      "production-map, dangerous-assumptions, decision-log, institutional-knowledge, " +
      "troubleshooting. Signal words in your discovery determine the routing.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "The holdout wall (craft/review) is for independent verification. " +
      "The reviewer sees only the spec and acceptance criteria — never the implementation. " +
      "On separate Marina instances connected via gateway, this is true network isolation.",
    importance: 9,
    type: "skill",
  },
  {
    content:
      "The 'tune' command scores your project across 7 dimensions: " +
      "spec quality, granularity, boundaries, knowledge capture, testing, " +
      "discovery flow, session discipline. Maps to Dan Shapiro's 5 levels.",
    importance: 8,
    type: "skill",
  },
  {
    content:
      "Gateway paradigm: bridge two Marina instances on the 'craft' channel. " +
      "Workshop on instance A, review on instance B. Specs flow A → B, " +
      "verdicts flow B → A. The craft rooms are TypeScript objects — " +
      "import them into any world.",
    importance: 10,
    type: "fact",
  },
  {
    content:
      "Craft rooms are portable. Any world can import them: " +
      "import { craftRooms } from './craft'; then spread into rooms. " +
      "Or run as a standalone world: MARINA_WORLD=craft. " +
      "Rooms are TypeScript objects — the same paradigm as interaction modes.",
    importance: 8,
    type: "fact",
  },
];

// ─── Seed ───────────────────────────────────────────────────────────────────

function seed(db: MarinaDB): void {
  seedTraitsAndRoles(db);

  const SYSTEM = "system";

  // Seed the craft channel
  if (!db.getChannel("ch:craft")) {
    db.createChannel({
      id: "ch:craft",
      type: "public",
      name: "craft",
      persistence: "permanent",
    });
  }

  // Seed the 5 knowledge pools
  for (const poolName of KNOWLEDGE_POOLS) {
    if (!db.getMemoryPool(poolName)) {
      const poolId = crypto.randomUUID();
      db.createMemoryPool(poolId, poolName, SYSTEM);
    }
  }

  // Seed a craft coordination project
  if (!db.getProjectByName("Craft")) {
    const projectId = crypto.randomUUID();

    const existingGroup = db.getGroupByName("craft");
    const groupId = existingGroup ? existingGroup.id : crypto.randomUUID();
    if (!existingGroup) {
      db.createGroup({
        id: groupId,
        name: "craft",
        description: "Spec-driven development coordination",
        leaderId: SYSTEM,
      });
    }

    const existingPool = db.getMemoryPool("craft");
    const poolId = existingPool ? existingPool.id : crypto.randomUUID();
    if (!existingPool) {
      db.createMemoryPool(poolId, "craft", SYSTEM, groupId);
    }

    db.createProject({
      id: projectId,
      name: "Craft",
      description: "Spec-driven development — interview, spec, implement, verify, ship",
      poolId,
      groupId,
      orchestration: "pipeline",
      createdBy: SYSTEM,
    });

    db.addPoolNote(
      poolId,
      SYSTEM,
      "Craft workflow: interview captures intent, specs decompose into testable units, " +
        "implementation tracks against criteria, discoveries route to knowledge pools, " +
        "review verifies independently.",
      9,
    );
    db.addPoolNote(
      poolId,
      SYSTEM,
      "Five knowledge pools for discovery routing: production-map, dangerous-assumptions, " +
        "decision-log, institutional-knowledge, troubleshooting. " +
        "Use 'discover <fact>' in the workshop to auto-classify.",
      8,
    );
  }
}

// ─── World Export ───────────────────────────────────────────────────────────

const craftWorld: WorldDefinition = {
  name: "Craft",
  startRoom: "craft/workshop" as RoomId,
  rooms: craftRooms(),
  quests: [],
  guideNotes: GUIDE_NOTES,
  seed,
};

export default craftWorld;
