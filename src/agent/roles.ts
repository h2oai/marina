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
  synergies: string[];
  tensions: string[];
}

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

  // Per-trait sets for cross-trait analysis
  const perTrait: {
    name: string;
    strengths: Set<string>;
    preferences: Set<string>;
    avoids: Set<string>;
  }[] = [];

  for (let i = 0; i < caps.length; i++) {
    const c = caps[i]!;
    const s = new Set(c.strengths ?? []);
    const p = new Set(c.preferences ?? []);
    const a = new Set(c.avoids ?? []);
    perTrait.push({ name: traitNames[i] ?? `trait-${i}`, strengths: s, preferences: p, avoids: a });
    for (const v of s) allStrengths.add(v);
    for (const v of p) allPreferences.add(v);
    for (const v of a) allAvoids.add(v);
  }

  const synergies: string[] = [];
  const tensions: string[] = [];

  // Cross-trait analysis (only meaningful with 2+ traits that have capabilities)
  const withCaps = perTrait.filter(
    (t) => t.strengths.size > 0 || t.preferences.size > 0 || t.avoids.size > 0,
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
      }
    }
  }

  return {
    strengths: [...allStrengths],
    preferences: [...allPreferences],
    avoids: [...allAvoids],
    synergies: [...new Set(synergies)],
    tensions: [...new Set(tensions)],
  };
}

/**
 * Format a composed capabilities block for inclusion in the role prompt.
 * Returns empty string if no capabilities data exists.
 */
export function formatCapabilitiesSection(composed: ComposedCapabilities): string {
  if (
    composed.strengths.length === 0 &&
    composed.preferences.length === 0 &&
    composed.avoids.length === 0
  ) {
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
 * Filter trait prompts + capabilities by task category. Traits without
 * `applicableTasks` declared are always kept (silent = always relevant).
 * Traits with `applicableTasks` declared are kept only when the current
 * `taskCategory` is in their list — otherwise the trait is suppressed
 * for the duration of this composition.
 *
 * Backward-compatible: when `taskCategory` is undefined, every trait is
 * kept regardless of `applicableTasks`. Existing seeded traits don't
 * declare the field yet, so the default behavior is unchanged.
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
    const applicable = caps.applicableTasks;
    if (applicable && applicable.length > 0 && !applicable.includes(taskCategory)) {
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
