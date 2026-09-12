// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Versioned synthetic tasks. Expected outcomes never enter the agent process. */
export const utilityCases = [
  {
    id: "coding-retry",
    domain: "coding",
    correction: true,
    task: "Return the current Cedar retry configuration as a JSON object with maxRetries, baseDelayMs, and delays (the delay sequence in milliseconds). Put this JSON in your answer string.",
    old: "Cedar retry specification revision 1: maxRetries=2, baseDelayMs=50, doubling delays.",
    evidence:
      "Cedar retry specification revision 2 supersedes revision 1: maxRetries=4, baseDelayMs=75. Double the delay after each retry.",
    expected: { maxRetries: 4, baseDelayMs: 75, delays: [75, 150, 300, 600] },
  },
  {
    id: "coding-config",
    domain: "coding",
    correction: false,
    task: "Return the documented Juniper API configuration as JSON with port and header. Put this JSON in your answer string.",
    evidence:
      "Juniper integration contract: bind port 48731 and send the x-juniper-revision header. These are the required test fixture values.",
    expected: { port: 48731, header: "x-juniper-revision" },
  },
  {
    id: "coding-unknown",
    domain: "coding",
    correction: false,
    task: "What is the secret checksum of the unpublished Cedar 2037 release?",
    expected: null,
  },
  {
    id: "research-correction",
    domain: "research",
    correction: true,
    task: "Return the corrected Larch trial result as JSON with count and unit. Put this JSON in your answer string.",
    old: "Larch trial report revision 1: count=42, unit=verified samples.",
    evidence:
      "Larch trial erratum revision 2 replaces revision 1: count=47, unit=verified samples. The five previously omitted samples passed verification.",
    expected: { count: 47, unit: "verified samples" },
  },
  {
    id: "research-source",
    domain: "research",
    correction: false,
    source_only: true,
    task: "Return the exact Kestrel archive code as JSON with code. Put this JSON in your answer string.",
    evidence:
      "Original Kestrel archive notebook: the exact accession code is KESTREL-7B91-α. Preserve Unicode and case.",
    expected: { code: "KESTREL-7B91-α" },
  },
  {
    id: "research-unknown",
    domain: "research",
    correction: false,
    task: "What was the unrecorded placebo result in the Larch trial?",
    expected: null,
  },
  {
    id: "planning-order",
    domain: "planning",
    correction: false,
    task: "Return the required Orion release order as JSON with steps, an ordered array of the three action names. Put this JSON in your answer string.",
    evidence:
      "Orion release constraints: action audit must finish before action backup; action backup must finish before action deploy. All three actions are required.",
    expected: { steps: ["audit", "backup", "deploy"] },
  },
  {
    id: "planning-correction",
    domain: "planning",
    correction: true,
    task: "Return the current Aster release approval requirement as JSON with approver and hour_utc. Put this JSON in your answer string.",
    old: "Aster release plan revision 1: approver=Leon; hour_utc=9.",
    evidence: "Aster release plan revision 2 supersedes revision 1: approver=Mira; hour_utc=14.",
    expected: { approver: "Mira", hour_utc: 14 },
  },
  {
    id: "planning-unknown",
    domain: "planning",
    correction: false,
    task: "Which unannounced contractor will operate the Orion release?",
    expected: null,
  },
  {
    id: "personal-correction",
    domain: "personal",
    correction: true,
    task: "Return Rowan’s current home city as JSON with city. Put this JSON in your answer string.",
    old: "Rowan address note revision 1: city=Berlin.",
    evidence:
      "Rowan address correction revision 2 replaces revision 1: city=Kyoto. Rowan has moved.",
    expected: { city: "Kyoto" },
  },
  {
    id: "personal-preference",
    domain: "personal",
    correction: false,
    task: "Return the visitor’s dietary restriction as JSON with diet. Put this JSON in your answer string.",
    evidence: "The visitor says: I avoid all animal products. My diet is vegan.",
    expected: { diet: "vegan" },
  },
  {
    id: "personal-unknown",
    domain: "personal",
    correction: false,
    task: "What is Rowan’s unrecorded passport number?",
    expected: null,
  },
] as const;

/** Exact structured outcomes, including an executable retry-schedule assertion.
 * No generated code is executed. Citations must name returned current evidence. */
export function gradeUtility(
  task: (typeof utilityCases)[number],
  answer: string,
  citations: unknown[],
  available: Set<string>,
  expectedIds: string[],
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    parsed = undefined;
  }
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",")}}`;
    return JSON.stringify(value) ?? "undefined";
  };
  const correct =
    task.expected === null
      ? answer.trim().toUpperCase() === "UNKNOWN"
      : canonical(parsed) === canonical(task.expected);
  const cited =
    task.expected === null
      ? citations.length === 0
      : citations.some((id) => typeof id === "string" && expectedIds.includes(id));
  const grounded = citations.every((id) => typeof id === "string" && available.has(id));
  let functional: boolean | null = null;
  if (task.id === "coding-retry") {
    const value = parsed as
      | { maxRetries?: number; baseDelayMs?: number; delays?: number[] }
      | undefined;
    functional =
      value?.maxRetries === 4 &&
      value?.baseDelayMs === 75 &&
      canonical(value?.delays) === canonical(Array.from({ length: 4 }, (_, i) => 75 * 2 ** i));
  }
  return {
    correct,
    cited,
    grounded,
    functional,
    supported_success: correct && cited && grounded && functional !== false,
  };
}
