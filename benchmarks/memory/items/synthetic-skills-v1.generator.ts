#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generator for `synthetic-skills-v1.json` — the skill-transfer item set.
 *
 * 12 fictional PROCEDURE families. Each family has one `skill` statement (the
 * procedure, imperative, no worked example) and 11 problems that require
 * applying it to fresh inputs: 10 are scored (`kind: "problem"`), the 11th is
 * the held-back worked example (`kind: "example"`) that the `family` split
 * seeds next to the procedure so the `<example>` tier has something to show.
 *
 * No real model can know these rules, so `bare` ≈ 0 and any lift is procedure
 * transfer, not lookup (HISTORY §7.2 showed Q/A notes about OTHER problems do
 * not transfer; this set asks whether a PROCEDURE does).
 *
 * Deterministic: a fixed-seed PRNG drives every input, and a rejection loop
 * guarantees (a) no scored problem's normalized answer appears as a substring
 * of ANY family's skill note (statement + worked example) — otherwise the
 * stub model, and a lazy real model, could "recall" it instead of applying the
 * rule; (b) no answer appears as a word inside its own question; (c) answers
 * are unique within a family. Re-running this file reproduces the committed JSON byte for
 * byte.
 *
 *   bun --env-file=/dev/null run benchmarks/memory/items/synthetic-skills-v1.generator.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const SKILLS_DATASET_VERSION = "synthetic-skills-v1";
const PROBLEMS_PER_FAMILY = 10;
const PRNG_SEED = 0x5c111;

// ─── Deterministic PRNG (mulberry32) ────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(PRNG_SEED);
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

/** Same normalization genbench's stub + judge use (SQuAD): lowercase, strip punctuation, articles. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const fmt = (n: number): string => {
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
};

// ─── Families ───────────────────────────────────────────────────────────────

interface Problem {
  question: string;
  answer: string;
}

interface Family {
  id: string;
  name: string;
  skill: string;
  /** Draw one fresh problem. Called repeatedly until the answer passes the leak checks. */
  draw(): Problem;
}

const WORDS = [
  "harbor",
  "lantern",
  "quarry",
  "meadow",
  "cistern",
  "orchard",
  "bramble",
  "tundra",
  "gantry",
  "pylon",
  "saffron",
  "cobalt",
  "mariner",
  "thistle",
  "granite",
  "velvet",
  "ember",
  "quill",
  "anchor",
  "beacon",
];
const VESSELS = [
  "Halcyon",
  "Meridian",
  "Sable",
  "Tempest",
  "Gossamer",
  "Wayfarer",
  "Lodestar",
  "Corsair",
  "Bellwether",
  "Nimbus",
  "Kestrel",
  "Vanguard",
];

const FAMILIES: Family[] = [
  {
    id: "varn-kell",
    name: "Varn–kell unit conversion",
    skill:
      "To convert between varn and kell, use the fixed ratio 1 varn = 7.5 kell: multiply a varn quantity by 7.5 to get kell, and divide a kell quantity by 7.5 to get varn. Report the plain number.",
    draw() {
      if (rand() < 0.5) {
        const v = randInt(3, 60);
        return { question: `How many kell are in ${v} varn?`, answer: fmt(v * 7.5) };
      }
      const v = randInt(3, 60);
      return { question: `How many varn are in ${fmt(v * 7.5)} kell?`, answer: fmt(v) };
    },
  },
  {
    id: "orlen-levy",
    name: "Orlen harbor levy (tiered fee)",
    skill:
      "The Orlen harbor levy is tiered by crate count: charge 4 dram per crate for the first 20 crates, 3 dram per crate for the next 30 crates, and 2 dram per crate for every crate beyond 50. Add the tiers together for the total levy in dram.",
    draw() {
      const n = randInt(5, 140);
      const t1 = Math.min(n, 20) * 4;
      const t2 = Math.max(0, Math.min(n, 50) - 20) * 3;
      const t3 = Math.max(0, n - 50) * 2;
      return {
        question: `A shipment of ${n} crates lands at Orlen. What is the total harbor levy in dram?`,
        answer: String(t1 + t2 + t3),
      };
    },
  },
  {
    id: "thessic-round",
    name: "Thessic round scoring",
    skill:
      "Score a Thessic round as 3 points per strike minus 2 points per fault. If the round has strictly more strikes than faults, add a 5-point bonus. The score may be negative.",
    draw() {
      const s = randInt(0, 14);
      const f = randInt(0, 14);
      const score = 3 * s - 2 * f + (s > f ? 5 : 0);
      return {
        question: `A Thessic round records ${s} strikes and ${f} faults. What is the round score?`,
        answer: String(score),
      };
    },
  },
  {
    id: "kelmar-calendar",
    name: "Kelmar calendar date offset",
    skill:
      "The Kelmar calendar has 13 months of exactly 28 days. To add days to a Kelmar date, convert it to a day-of-year with 28 × (month − 1) + day, add the offset, wrap past 364 into the next year, and convert back to month/day.",
    draw() {
      const m = randInt(1, 13);
      const d = randInt(1, 28);
      const k = randInt(5, 120);
      const doy = 28 * (m - 1) + d + k;
      const wrapped = ((doy - 1) % 364) + 1;
      const nm = Math.floor((wrapped - 1) / 28) + 1;
      const nd = ((wrapped - 1) % 28) + 1;
      return {
        question: `Which Kelmar date falls ${k} days after month ${m}, day ${d}? Answer as month/day.`,
        answer: `${nm}/${nd}`,
      };
    },
  },
  {
    id: "brannock-check",
    name: "Brannock check number",
    skill:
      "The Brannock check number of a numeral is computed by multiplying each digit by its 1-based position counted from the left, summing those products, and taking the sum modulo 97. Report the remainder as a plain number.",
    draw() {
      const n = randInt(1000, 99999);
      const digits = String(n).split("").map(Number);
      const sum = digits.reduce((acc, dgt, i) => acc + dgt * (i + 1), 0);
      return {
        question: `What is the Brannock check number of ${n}?`,
        answer: String(sum % 97),
      };
    },
  },
  {
    id: "rell-discount",
    name: "Rell market discount stacking",
    skill:
      "Rell's market applies price adjustments in a fixed order: first subtract the flat coupon from the list price, then apply the percentage discount to what remains, then add the 12 lumen handling fee. Round the result to the nearest whole lumen.",
    draw() {
      const price = randInt(80, 900);
      const coupon = pick([10, 15, 25, 30, 40, 50, 60, 75]);
      const pct = pick([5, 10, 15, 20, 25, 30, 35, 40]);
      const total = Math.round((price - coupon) * (1 - pct / 100) + 12);
      return {
        question: `At Rell's market an item lists at ${price} lumen with a ${coupon} lumen coupon and a ${pct}% discount. What is the final price in lumen?`,
        answer: String(total),
      };
    },
  },
  {
    id: "pell-burn",
    name: "Pell fuel burn for a round trip",
    skill:
      "A vessel burns 6 pell per league while loaded and 4 pell per league while empty. The outbound leg is loaded and the return leg is empty, and every round trip pays a fixed 15 pell docking charge. Total pell = 6 × leagues + 4 × leagues + 15.",
    draw() {
      const l = randInt(4, 95);
      return {
        question: `A vessel sails ${l} leagues out to Pell Reach and back. How much pell does the round trip burn in total?`,
        answer: String(10 * l + 15),
      };
    },
  },
  {
    id: "corvane-class",
    name: "Corvane stowage fee",
    skill:
      "To price Corvane stowage, first find the item's class: its mass in stone divided by 15, rounded up to the next whole number, minimum class 1. Then charge 9 crowns per class, and add a 4 crown surcharge if the item is fragile.",
    draw() {
      const mass = randInt(2, 400);
      const fragile = rand() < 0.4;
      const cls = Math.max(1, Math.ceil(mass / 15));
      return {
        question: `A ${fragile ? "fragile" : "sturdy"} cargo item weighs ${mass} stone. What is its Corvane stowage fee in crowns?`,
        answer: String(9 * cls + (fragile ? 4 : 0)),
      };
    },
  },
  {
    id: "oddric-code",
    name: "Oddric word code",
    skill:
      "The Oddric code of a word is three times its letter count, plus five times the number of vowels it contains (counting a, e, i, o and u), plus the alphabet position of its first letter (a = 1, b = 2, ..., z = 26). Report the code as a plain number.",
    draw() {
      const w = pick(WORDS);
      const vowels = (w.match(/[aeiou]/g) ?? []).length;
      const first = w.charCodeAt(0) - "a".charCodeAt(0) + 1;
      return {
        question: `What is the Oddric code of the word "${w}"?`,
        answer: String(3 * w.length + 5 * vowels + first),
      };
    },
  },
  {
    id: "maroth-berth",
    name: "Maroth berth code",
    skill:
      "A Maroth berth code is the vessel name's first letter in uppercase, immediately followed by the hull length in cubits divided by 10 and rounded down, then a hyphen, then the remainder when the hull length is divided by 7. Write it with no spaces.",
    draw() {
      const name = pick(VESSELS);
      const len = randInt(31, 189);
      return {
        question: `The vessel ${name} has a hull length of ${len} cubits. What is its Maroth berth code?`,
        answer: `${name[0]}${Math.floor(len / 10)}-${len % 7}`,
      };
    },
  },
  {
    id: "tarn-loan",
    name: "Tarn loan repayment",
    skill:
      "A Tarn loan accrues simple interest of 4 marks per 100 marks borrowed for each season it is held. Total repayment = principal + principal × 0.04 × seasons. Report the repayment in marks.",
    draw() {
      const p = pick([150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 750, 800, 900, 1200]);
      const s = randInt(1, 9);
      return {
        question: `A Tarn loan of ${p} marks is held for ${s} seasons. What is the total repayment in marks?`,
        answer: fmt(p + p * 0.04 * s),
      };
    },
  },
  {
    id: "vellum-grade",
    name: "Vellum sheet grading",
    skill:
      "Grade a Vellum sheet by starting at 100 and subtracting 7 for every blemish and 3 for every crease. The grade never falls below 0.",
    draw() {
      const b = randInt(0, 9);
      const c = randInt(0, 12);
      return {
        question: `A Vellum sheet shows ${b} blemishes and ${c} creases. What is its grade?`,
        answer: String(Math.max(0, 100 - 7 * b - 3 * c)),
      };
    },
  },
];

// ─── Assembly ───────────────────────────────────────────────────────────────

export interface SkillItem {
  id: string;
  question: string;
  answer: string;
  category: string;
  metadata: {
    familyId: string;
    family: string;
    kind: "problem" | "example";
    skill: string;
  };
}

/** The text the `family` split seeds for a family: procedure + one worked example. */
export function skillNoteContent(family: { id: string; skill: string }, example: Problem): string {
  return `[Skill: ${family.id}] ${family.skill} || Example: Q: ${example.question} A: ${example.answer}`;
}

/** Token-bounded containment (an answer as a whole word run). */
const containsToken = (haystack: string, needle: string): boolean =>
  ` ${normalize(haystack)} `.includes(` ${normalize(needle)} `);

/**
 * Raw normalized-substring containment — the check genbench's stub model
 * applies to the injected context ("gold text appears in memory"), so notes
 * must be clean under it too or `fullcontext` would score above `bare` for
 * reasons that have nothing to do with the procedure.
 */
const containsRaw = (haystack: string, needle: string): boolean =>
  normalize(haystack).includes(normalize(needle));

export function generate(): { version: string; description: string; items: SkillItem[] } {
  // Worked examples first — they are part of every note, so problem answers
  // are rejected against them too.
  const examples = FAMILIES.map((f) => f.draw());
  const noteTexts = FAMILIES.map((f, i) => skillNoteContent(f, examples[i] as Problem));
  const items: SkillItem[] = [];
  FAMILIES.forEach((family, fi) => {
    const seen = new Set<string>();
    const problems: Problem[] = [];
    let guard = 0;
    while (problems.length < PROBLEMS_PER_FAMILY) {
      if (++guard > 10_000) throw new Error(`family ${family.id}: could not draw enough problems`);
      const p = family.draw();
      const a = normalize(p.answer);
      if (!a || seen.has(a)) continue;
      if (noteTexts.some((t) => containsRaw(t, p.answer))) continue;
      if (containsToken(p.question, p.answer)) continue;
      seen.add(a);
      problems.push(p);
    }
    const meta = (kind: SkillItem["metadata"]["kind"]) => ({
      familyId: family.id,
      family: family.name,
      kind,
      skill: family.skill,
    });
    problems.forEach((p, k) => {
      items.push({
        id: `skl-${family.id}-${String(k + 1).padStart(2, "0")}`,
        question: p.question,
        answer: p.answer,
        category: "synthetic-skill",
        metadata: meta("problem"),
      });
    });
    const ex = examples[fi] as Problem;
    items.push({
      id: `skl-${family.id}-ex`,
      question: ex.question,
      answer: ex.answer,
      category: "synthetic-skill",
      metadata: meta("example"),
    });
  });
  return {
    version: SKILLS_DATASET_VERSION,
    description: `${FAMILIES.length} fictional procedure families x ${PROBLEMS_PER_FAMILY} problems (+1 held-back worked example each). Every problem requires applying the family's procedure to fresh inputs; no answer appears in any procedure statement or worked example. No real model can know these rules, so bare is ~0 and any lift is procedure transfer, not lookup. Generated by synthetic-skills-v1.generator.ts (deterministic).`,
    items,
  };
}

if (import.meta.main) {
  const out = generate();
  const path = join(import.meta.dir, "synthetic-skills-v1.json");
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${out.items.length} items to ${path}`);
}
