// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Role/Trait Resolution — reads composable roles from the platform DB
 * and produces effective prompts for agent system prompt injection.
 *
 * Roles are compositions of reusable traits + guidelines + focus + tone.
 * Traits are atomic prompt fragments stored in the DB.
 * Both are seedable by world definitions and discoverable via commands.
 *
 * Semantic composition: traits carry optional structured capabilities
 * (strengths, preferences, avoids, domains, behaviors, activation cues,
 * success/risk signals, and task applicability). When composed, the system
 * detects synergies (overlapping strengths/preferences) and tensions (a trait's
 * strength overlapping another's avoids) to give agents structured
 * reasoning signals.
 */

import type { MarinaDB, TraitCapabilities } from "../persistence/database";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ResolvedRole {
  name: string;
  description: string;
  traitNames: string[];
  missingTraitNames: string[];
  traitPrompts: string[];
  traitCapabilities: TraitCapabilities[];
  guidelines: string[];
  focus: string[];
  tone: string;
  origin: string;
}

interface ComposedCapabilities {
  strengths: string[];
  preferences: string[];
  avoids: string[];
  domains: string[];
  behaviors: string[];
  antiBehaviors: string[];
  successSignals: string[];
  riskSignals: string[];
  /** Free-text activation cues, with control tokens (always/task-category) stripped. */
  activationCues: string[];
  synergies: string[];
  tensions: string[];
}

/**
 * Activation tokens that control gating rather than describe it. They are
 * recognized by `filterTraitsByTask` and stripped before activation cues are
 * rendered as agent-facing guidance.
 */
const ACTIVATION_ALWAYS = "always";
const ACTIVATION_TASK_CATEGORY = "task-category";
const CONTROL_ACTIVATION_TOKENS = new Set([ACTIVATION_ALWAYS, ACTIVATION_TASK_CATEGORY]);

// ─── Capability Composition ─────────────────────────────────────────────────

/**
 * Merge capabilities from multiple traits and detect synergies/tensions.
 *
 * Synergies: when a strength from one trait appears as a preference in another,
 * or when multiple traits share the same strength — they reinforce each other.
 *
 * Tensions: when a strength or preference from one trait appears in another
 * trait's avoids list — they pull in opposite directions.
 */
export function composeCapabilities(
  traitNames: string[],
  caps: TraitCapabilities[],
): ComposedCapabilities {
  const allStrengths = new Set<string>();
  const allPreferences = new Set<string>();
  const allAvoids = new Set<string>();
  const allDomains = new Set<string>();
  const allBehaviors = new Set<string>();
  const allAntiBehaviors = new Set<string>();
  const allSuccessSignals = new Set<string>();
  const allRiskSignals = new Set<string>();
  const allActivationCues = new Set<string>();

  // Per-trait sets for cross-trait analysis
  const perTrait: {
    name: string;
    strengths: Set<string>;
    preferences: Set<string>;
    avoids: Set<string>;
    behaviors: Set<string>;
    antiBehaviors: Set<string>;
  }[] = [];

  for (let i = 0; i < caps.length; i++) {
    const c = caps[i]!;
    const s = new Set(c.strengths ?? []);
    const p = new Set(c.preferences ?? []);
    const a = new Set(c.avoids ?? []);
    const b = new Set(c.behaviors ?? []);
    const ab = new Set(c.antiBehaviors ?? []);
    perTrait.push({
      name: traitNames[i] ?? `trait-${i}`,
      strengths: s,
      preferences: p,
      avoids: a,
      behaviors: b,
      antiBehaviors: ab,
    });
    for (const v of s) allStrengths.add(v);
    for (const v of p) allPreferences.add(v);
    for (const v of a) allAvoids.add(v);
    for (const v of c.domains ?? []) allDomains.add(v);
    for (const v of b) allBehaviors.add(v);
    for (const v of ab) allAntiBehaviors.add(v);
    for (const v of c.successSignals ?? []) allSuccessSignals.add(v);
    for (const v of c.riskSignals ?? []) allRiskSignals.add(v);
    for (const v of c.activation ?? []) {
      if (!CONTROL_ACTIVATION_TOKENS.has(v.toLowerCase())) allActivationCues.add(v);
    }
  }

  const synergies: string[] = [];
  const tensions: string[] = [];

  // Cross-trait analysis (only meaningful with 2+ traits that have capabilities)
  const withCaps = perTrait.filter(
    (t) =>
      t.strengths.size > 0 ||
      t.preferences.size > 0 ||
      t.avoids.size > 0 ||
      t.behaviors.size > 0 ||
      t.antiBehaviors.size > 0,
  );

  if (withCaps.length >= 2) {
    // Detect synergies: strength in one trait matches preference in another
    for (let i = 0; i < withCaps.length; i++) {
      for (let j = i + 1; j < withCaps.length; j++) {
        const a = withCaps[i]!;
        const b = withCaps[j]!;

        // Strength↔preference synergy
        for (const s of a.strengths) {
          if (b.preferences.has(s)) {
            synergies.push(
              `Your ${s} strength (${a.name}) pairs with your ${s} preference (${b.name})`,
            );
          }
        }
        for (const s of b.strengths) {
          if (a.preferences.has(s)) {
            synergies.push(
              `Your ${s} strength (${b.name}) pairs with your ${s} preference (${a.name})`,
            );
          }
        }

        // Shared strengths reinforce
        for (const s of a.strengths) {
          if (b.strengths.has(s)) {
            synergies.push(`Both ${a.name} and ${b.name} reinforce ${s}`);
          }
        }

        // Tension: strength/preference vs avoids
        for (const s of a.strengths) {
          if (b.avoids.has(s)) {
            tensions.push(
              `Your ${s} strength (${a.name}) may conflict with ${b.name} which avoids ${s}`,
            );
          }
        }
        for (const s of b.strengths) {
          if (a.avoids.has(s)) {
            tensions.push(
              `Your ${s} strength (${b.name}) may conflict with ${a.name} which avoids ${s}`,
            );
          }
        }
        for (const p of a.preferences) {
          if (b.avoids.has(p)) {
            tensions.push(
              `Your ${p} preference (${a.name}) may conflict with ${b.name} which avoids ${p}`,
            );
          }
        }
        for (const p of b.preferences) {
          if (a.avoids.has(p)) {
            tensions.push(
              `Your ${p} preference (${b.name}) may conflict with ${a.name} which avoids ${p}`,
            );
          }
        }

        // Tension: a behavior one trait practices is another's anti-behavior
        for (const beh of a.behaviors) {
          if (b.antiBehaviors.has(beh)) {
            tensions.push(`${a.name} practices ${beh} but ${b.name} treats it as an anti-pattern`);
          }
        }
        for (const beh of b.behaviors) {
          if (a.antiBehaviors.has(beh)) {
            tensions.push(`${b.name} practices ${beh} but ${a.name} treats it as an anti-pattern`);
          }
        }
      }
    }
  }

  return {
    strengths: [...allStrengths],
    preferences: [...allPreferences],
    avoids: [...allAvoids],
    domains: [...allDomains],
    behaviors: [...allBehaviors],
    antiBehaviors: [...allAntiBehaviors],
    successSignals: [...allSuccessSignals],
    riskSignals: [...allRiskSignals],
    activationCues: [...allActivationCues],
    synergies: [...new Set(synergies)],
    tensions: [...new Set(tensions)],
  };
}

/**
 * Format a composed capabilities block for inclusion in the role prompt.
 * Returns empty string if no capabilities data exists.
 */
export function formatCapabilitiesSection(composed: ComposedCapabilities): string {
  const hasAny =
    composed.strengths.length > 0 ||
    composed.preferences.length > 0 ||
    composed.avoids.length > 0 ||
    composed.domains.length > 0 ||
    composed.behaviors.length > 0 ||
    composed.antiBehaviors.length > 0 ||
    composed.successSignals.length > 0 ||
    composed.riskSignals.length > 0 ||
    composed.activationCues.length > 0;
  if (!hasAny) {
    return "";
  }

  const lines: string[] = ["## Capabilities Profile"];

  if (composed.strengths.length > 0) {
    lines.push(`Strengths: ${composed.strengths.join(", ")}`);
  }
  if (composed.preferences.length > 0) {
    lines.push(`Preferences: ${composed.preferences.join(", ")}`);
  }
  if (composed.avoids.length > 0) {
    lines.push(`Avoids: ${composed.avoids.join(", ")}`);
  }
  if (composed.domains.length > 0) {
    lines.push(`Domains: ${composed.domains.join(", ")}`);
  }
  // Behavioral guidance for self-orientation: what to do, what to avoid, and
  // how to tell it's working. Surfaced (not enforced) so agents choose, per the
  // autonomy principle — these inform, they don't control.
  if (composed.behaviors.length > 0) {
    lines.push(`Practices: ${composed.behaviors.join(", ")}`);
  }
  if (composed.antiBehaviors.length > 0) {
    lines.push(`Anti-patterns: ${composed.antiBehaviors.join(", ")}`);
  }
  if (composed.activationCues.length > 0) {
    lines.push(`Lean in when: ${composed.activationCues.join(", ")}`);
  }
  if (composed.successSignals.length > 0) {
    lines.push(`Working well when: ${composed.successSignals.join(", ")}`);
  }
  if (composed.riskSignals.length > 0) {
    lines.push(`Watch for: ${composed.riskSignals.join(", ")}`);
  }

  if (composed.synergies.length > 0) {
    lines.push("");
    lines.push(`Synergies: ${composed.synergies.join(". ")}.`);
  }
  if (composed.tensions.length > 0) {
    lines.push("");
    lines.push(`Tensions: ${composed.tensions.join(". ")}.`);
  }

  return lines.join("\n");
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve a role by name from the database.
 * Looks up the role, then resolves each referenced trait.
 * Returns null if the role doesn't exist.
 */
export function resolveRole(db: MarinaDB, roleName: string): ResolvedRole | null {
  const row = db.getRole(roleName);
  if (!row) return null;

  const requestedTraitNames: string[] = JSON.parse(row.traits);
  const traitNames: string[] = [];
  const missingTraitNames: string[] = [];
  const traitPrompts: string[] = [];
  const traitCapabilities: TraitCapabilities[] = [];

  for (const traitName of requestedTraitNames) {
    const trait = db.getTrait(traitName);
    if (trait) {
      traitNames.push(traitName);
      traitPrompts.push(trait.prompt);
      const caps: TraitCapabilities = JSON.parse(trait.capabilities || "{}");
      traitCapabilities.push(caps);
    } else {
      missingTraitNames.push(traitName);
    }
  }

  return {
    name: row.name,
    description: row.description,
    traitNames,
    missingTraitNames,
    traitPrompts,
    traitCapabilities,
    guidelines: JSON.parse(row.guidelines),
    focus: JSON.parse(row.focus),
    tone: row.tone,
    origin: row.origin,
  };
}

/**
 * The set of task categories a trait scopes itself to, if any. Two typed
 * sources contribute:
 *   - `applicableTasks` — the original whitelist; always defines scope.
 *   - `domains` — the typed metadata field, but only when the trait opts into
 *     category gating via `activation: ["task-category"]`. Otherwise `domains`
 *     is purely descriptive (rendered, not gated) so adding it never silently
 *     suppresses a trait.
 * An empty result means "no declared scope" → the trait is always relevant.
 */
function traitTaskScope(caps: TraitCapabilities): string[] {
  const scope = [...(caps.applicableTasks ?? [])];
  const activation = new Set((caps.activation ?? []).map((a) => a.toLowerCase()));
  if (activation.has(ACTIVATION_TASK_CATEGORY)) {
    scope.push(...(caps.domains ?? []));
  }
  return scope;
}

/**
 * Decide whether a trait stays active for the current inferred task category.
 *
 * Conservative by design (false-positive suppression silences a useful trait,
 * which is worse than leaving it always-on):
 *   - `activation: ["always"]` is an explicit escape hatch — never suppressed.
 *   - A trait with no declared scope (no `applicableTasks`, and no `domains`
 *     opted into via `task-category` activation) is always kept.
 *   - Otherwise the trait is kept only when `taskCategory` is in its scope.
 */
export function isTraitActiveForCategory(caps: TraitCapabilities, taskCategory: string): boolean {
  const activation = new Set((caps.activation ?? []).map((a) => a.toLowerCase()));
  if (activation.has(ACTIVATION_ALWAYS)) return true;
  const scope = traitTaskScope(caps);
  if (scope.length === 0) return true;
  return scope.includes(taskCategory);
}

/**
 * Filter trait prompts + capabilities by task category (PRISM-style gating).
 * Gating is driven by typed `activation`/`domains` where present, falling back
 * to the original `applicableTasks` whitelist — see {@link isTraitActiveForCategory}.
 *
 * Backward-compatible: when `taskCategory` is undefined, every trait is kept.
 * Traits that declare no scope are always kept regardless of category.
 */
function filterTraitsByTask(
  role: ResolvedRole,
  taskCategory: string | undefined,
): { traitNames: string[]; traitPrompts: string[]; traitCapabilities: TraitCapabilities[] } {
  if (!taskCategory) {
    return {
      traitNames: role.traitNames,
      traitPrompts: role.traitPrompts,
      traitCapabilities: role.traitCapabilities,
    };
  }
  const keptNames: string[] = [];
  const keptPrompts: string[] = [];
  const keptCaps: TraitCapabilities[] = [];
  for (let i = 0; i < role.traitNames.length; i++) {
    const caps = role.traitCapabilities[i] ?? {};
    if (!isTraitActiveForCategory(caps, taskCategory)) {
      continue; // suppress: trait declared scope and current task isn't in it
    }
    keptNames.push(role.traitNames[i] ?? "");
    keptPrompts.push(role.traitPrompts[i] ?? "");
    keptCaps.push(caps);
  }
  return { traitNames: keptNames, traitPrompts: keptPrompts, traitCapabilities: keptCaps };
}

/**
 * Compose an effective system prompt section from a resolved role.
 * This is injected into the lean agent's system prompt at spawn time.
 *
 * Format matches what the lean agent expects:
 *   # YOUR ROLE: <NAME>
 *   <trait prompts>
 *   ## Capabilities Profile (if traits have structured capabilities)
 *   ## Focus Areas
 *   ## Behavioral Guidelines
 *   ## Tone
 *
 * `taskCategory` (optional): when provided, traits whose
 * `applicableTasks` doesn't include the category are suppressed (PRISM-
 * style gating, see TraitCapabilities).
 */
export function composeRolePrompt(role: ResolvedRole, taskCategory?: string): string {
  const sections: string[] = [];

  sections.push(`# YOUR ROLE: ${role.name.toUpperCase()}`);

  if (role.description) {
    sections.push(role.description);
  }

  const filtered = filterTraitsByTask(role, taskCategory);

  if (filtered.traitPrompts.length > 0) {
    sections.push(filtered.traitPrompts.join("\n\n"));
  }

  // Semantic capabilities section (composed from FILTERED traits so
  // suppressed traits don't contribute synergies/tensions either).
  const composed = composeCapabilities(filtered.traitNames, filtered.traitCapabilities);
  const capSection = formatCapabilitiesSection(composed);
  if (capSection) {
    sections.push(capSection);
  }

  if (role.focus.length > 0) {
    sections.push(`## Focus Areas\n${role.focus.map((f) => `- ${f}`).join("\n")}`);
  }

  if (role.guidelines.length > 0) {
    sections.push(`## Behavioral Guidelines\n${role.guidelines.map((g) => `- ${g}`).join("\n")}`);
  }

  if (role.tone) {
    sections.push(`## Tone\n${role.tone}`);
  }

  return sections.join("\n\n");
}

/**
 * Convenience: resolve a role and compose its prompt in one call.
 * Returns null if the role doesn't exist.
 *
 * `taskCategory` (optional): forwarded to composeRolePrompt for
 * task-conditional trait gating.
 */
export function getRolePrompt(
  db: MarinaDB,
  roleName: string,
  taskCategory?: string,
): string | null {
  const role = resolveRole(db, roleName);
  if (!role) return null;
  return composeRolePrompt(role, taskCategory);
}

/**
 * Voice-friendly single-word category inference from a goal/focus
 * string. Used at spawn time to seed PRISM-style trait gating without
 * any agent-side metadata. Returns undefined when no signal — caller
 * should not gate. Keep keyword lists tight: false-positive gating
 * silences a useful trait worse than always-on does.
 */
export function inferTaskCategory(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();
  // Order matters: more specific patterns first.
  if (/\b(humaneval|coding|implement|refactor|debug|typescript|python)\b/.test(lower))
    return "code";
  if (/\b(math|gsm8k|aime|equation|theorem|arithmetic|calculus)\b/.test(lower)) return "math";
  if (/\b(forecast|prediction|brier|calibration|odds)\b/.test(lower)) return "forecasting";
  if (/\b(bet|wager|market|kelly|kalshi|polymarket|position)\b/.test(lower)) return "trading";
  if (/\b(research|investigate|literature|paper|cite)\b/.test(lower)) return "research";
  if (/\b(write|draft|essay|story|prose|narrative)\b/.test(lower)) return "writing";
  if (/\b(reason|deduce|logic|infer)\b/.test(lower)) return "reasoning";
  if (/\b(safety|alignment|ethics|harm)\b/.test(lower)) return "alignment";
  return undefined;
}
