// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The world command each typed ANALYSIS tool sends (`tools/analysis.ts`):
 * forecast, research, the read swarm, quant, calc, data, decision check,
 * triage, the Arbiter and text patterns. Pure and import-free so the tool
 * wrappers and the tool policy (`typedToolCommand`, `tool-policy.ts`) build
 * the SAME string — the policy classifies exactly what the tool runs, and the
 * command's own rank, gates, spend caps and audit apply as typed.
 *
 * Builders throw an `Error` with a fix-it message when the arguments cannot
 * make a valid command (the tool call then fails before anything is sent).
 */

type Args = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

/** One `key:value` modifier; values are single tokens (the parser splits on whitespace). */
function mod(tool: string, key: string, value: string | number | undefined): string[] {
  if (value === undefined || value === "") return [];
  const text = String(value);
  if (/\s/.test(text)) {
    throw new Error(`${tool}: ${key} must not contain spaces (got "${text}")`);
  }
  return [`${key}:${text}`];
}

function need(tool: string, field: string, value: string): string {
  if (!value) throw new Error(`${tool} needs ${field}.`);
  return value;
}

/** `head [mods…] -- text` when there are modifiers, else `head text` (the plain form). */
function withText(head: string, mods: string[], text: string): string {
  return mods.length ? `${head} ${mods.join(" ")} -- ${text}` : `${head} ${text}`;
}

/** Typed-answer modifiers shared by forecast and triage. */
function answerMods(tool: string, a: Args): string[] {
  const options = list(a.options);
  return [
    ...mod(tool, "type", str(a.type)),
    ...mod(tool, "options", options.length ? options.join(",") : undefined),
    ...mod(tool, "size", num(a.size)),
    ...mod(tool, "ends", str(a.ends)),
  ];
}

export function forecastToolCommand(a: Args): string {
  const t = "marina_forecast";
  const action = str(a.action) || "ask";
  if (action === "list") return "forecast list";
  if (action === "competence")
    return `forecast competence${str(a.family) ? ` ${str(a.family)}` : ""}`;
  const question = need(t, "question", str(a.question)).replace(/[\r\n]+/g, " ");
  return withText(
    "forecast",
    [
      ...answerMods(t, a),
      ...mod(t, "resolves", str(a.resolves)),
      ...mod(t, "formation", str(a.formation)),
      ...mod(t, "retriever", str(a.retriever)),
    ],
    question,
  );
}

export function researchToolCommand(a: Args): string {
  const t = "marina_research";
  const question = need(t, "question", str(a.question)).replace(/[\r\n]+/g, " ");
  return `research ask ${[
    ...mod(t, "mode", str(a.mode)),
    ...mod(t, "retriever", str(a.retriever)),
    ...mod(t, "measure", str(a.measure)),
    ...mod(t, "budget", num(a.budgetUsd)),
  ]
    .concat(["--", question])
    .join(" ")}`;
}

export function swarmToolCommand(a: Args): string {
  const t = "marina_swarm";
  const question = need(t, "question", str(a.question)).replace(/[\r\n]+/g, " ");
  const engines = list(a.engines);
  const mods = [
    ...mod(t, "engines", engines.length ? engines.join(",") : undefined),
    ...mod(t, "docs", num(a.docs)),
  ];
  return `web swarm ${[...mods, question].join(" ")}`;
}

export function calcToolCommand(a: Args): string {
  return `calc ${need("marina_calc", "expression", str(a.expression))}`;
}

export function quantToolCommand(a: Args): string {
  const t = "marina_quant";
  const action = str(a.action);
  const buckets = str(a.buckets);
  if (action === "fit") {
    const values = Array.isArray(a.values) ? a.values.map((v) => String(v).trim()) : [];
    if (values.length < 2)
      throw new Error(`${t} action=fit needs values (2 or more, oldest first).`);
    if (values.some((v) => !v || /\s/.test(v))) {
      throw new Error(`${t}: each value is a number or a date=value pair, without spaces.`);
    }
    const mods = [
      ...mod(t, "steps", num(a.steps)),
      ...mod(t, "to", str(a.to)),
      ...mod(t, "method", str(a.method)),
    ];
    return `quant fit ${[...values, ...mods].join(" ")}${buckets ? ` -- ${buckets}` : ""}`;
  }
  if (action === "buckets") {
    const quantiles = Array.isArray(a.quantiles)
      ? (a.quantiles as Array<{ level?: unknown; value?: unknown }>)
          .map((q) => `${num(q?.level)}=${num(q?.value)}`)
          .filter((q) => !q.includes("undefined"))
      : [];
    const cuts = Array.isArray(a.cuts) ? a.cuts.map(num).filter((x) => x !== undefined) : [];
    const dist =
      quantiles.length > 0
        ? mod(t, "q", quantiles.join(","))
        : [...mod(t, "mean", num(a.mean)), ...mod(t, "sd", num(a.sd))];
    if (dist.length === 0) throw new Error(`${t} action=buckets needs mean and sd, or quantiles.`);
    if (cuts.length > 0)
      return `quant buckets ${[...dist, ...mod(t, "cuts", cuts.join(","))].join(" ")}`;
    return `quant buckets ${dist.join(" ")} -- ${need(t, "buckets (or cuts)", buckets)}`;
  }
  throw new Error(`${t} action must be fit or buckets.`);
}

export const DATA_TOOL_SOURCES = [
  "markets",
  "odds",
  "series",
  "polls",
  "crowd",
  "sources",
] as const;

export function dataToolCommand(a: Args): string {
  const t = "marina_data";
  const source = str(a.source);
  if (!(DATA_TOOL_SOURCES as readonly string[]).includes(source)) {
    throw new Error(`${t} source must be one of ${DATA_TOOL_SOURCES.join(", ")}.`);
  }
  if (source === "sources") return "data sources";
  const mods = [
    ...mod(t, "asof", str(a.asOf)),
    ...(source === "polls" ? mod(t, "exclude", list(a.exclude).join(",") || undefined) : []),
  ];
  if (source === "polls") {
    const pollType = need(t, "pollType (approval or generic-ballot)", str(a.pollType));
    const subject = need(t, "query (the poll subject, e.g. Donald Trump)", str(a.query));
    return `data polls ${[...mods, pollType, subject].join(" ")}`;
  }
  const query = need(t, "query", str(a.query)).replace(/[\r\n]+/g, " ");
  return `data ${source} ${[...mods, query].join(" ")}`;
}

export function decisionCheckToolCommand(a: Args): string {
  const t = "marina_decision_check";
  const draft = need(t, "draft", str(a.draft)).replace(/[\r\n]+/g, " ");
  // `|` separates the request from the draft, so the request may not contain one.
  const request = str(a.request)
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "/");
  // A draft with its own `|` and no request gets an empty request in front.
  return `decision check ${request || draft.includes("|") ? `${request} | ` : ""}${draft}`.replace(
    "check  |",
    "check |",
  );
}

export function triageToolCommand(a: Args): string {
  const t = "marina_triage";
  const question = need(t, "question", str(a.question)).replace(/[\r\n]+/g, " ");
  return withText(
    "triage",
    [...answerMods(t, a), ...mod(t, "resolves", str(a.resolves)), ...mod(t, "asof", str(a.asOf))],
    question,
  );
}

export function arbiterToolCommand(a: Args): string {
  const t = "marina_arbiter";
  const action = str(a.action);
  if (action === "policy") return "arbiter policy";
  const type = mod(t, "type", str(a.type));
  if (action === "contested") {
    const answers = list(a.answers).map((x) => x.replace(/\|/g, "/").replace(/[\r\n]+/g, " "));
    if (answers.length < 2) throw new Error(`${t} action=contested needs answers (2 or more).`);
    return `arbiter contested ${[...type, "--", answers.join(" | ")].join(" ")}`;
  }
  if (action === "check") {
    const verdict = need(t, "verdict (the Arbiter's JSON reply)", str(a.verdict)).replace(
      /[\r\n]+/g,
      " ",
    );
    return `arbiter check ${[
      ...type,
      ...mod(t, "majority", str(a.majority)),
      ...mod(t, "agreement", num(a.agreement)),
      "--",
      verdict,
    ].join(" ")}`;
  }
  throw new Error(`${t} action must be contested, check or policy.`);
}

export function patternToolCommand(a: Args): string {
  const t = "marina_pattern";
  if (str(a.action) === "list") return "pattern list";
  const pattern = need(t, "pattern", str(a.pattern));
  const task = need(t, "task", str(a.task)).replace(/[\r\n]+/g, " ");
  return `pattern run ${[pattern, ...mod(t, "budget", num(a.budgetUsd)), "--", task].join(" ")}`;
}

/** Tool name → command builder, for every typed analysis tool. */
export const ANALYSIS_TOOL_COMMANDS: Readonly<Record<string, (a: Args) => string>> = {
  marina_forecast: forecastToolCommand,
  marina_research: researchToolCommand,
  marina_swarm: swarmToolCommand,
  marina_quant: quantToolCommand,
  marina_calc: calcToolCommand,
  marina_data: dataToolCommand,
  marina_decision_check: decisionCheckToolCommand,
  marina_triage: triageToolCommand,
  marina_arbiter: arbiterToolCommand,
  marina_pattern: patternToolCommand,
};

/** The typed analysis tools, in catalog order. */
export const ANALYSIS_TOOL_NAMES: readonly string[] = Object.keys(ANALYSIS_TOOL_COMMANDS);
