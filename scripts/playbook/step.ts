// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Judging one playbook step's outcome, shared by the in-process test and the
 * live runner so both read the catalogue the same way.
 */

import type { PlaybookStep } from "./catalog";

export interface StepOutcome {
  /** Whether the command completed as a success (false = refused or failed). */
  ok: boolean;
  /** The reply text, ANSI stripped. */
  text: string;
  /** The completion's error, when it failed. */
  error?: string;
}

export { stripAnsi } from "../../src/net/ansi";

/** Every problem with an outcome against its step; empty when the step held. */
export function judgeStep(step: PlaybookStep, outcome: StepOutcome): string[] {
  const problems: string[] = [];
  const want = step.expect ?? "ok";
  if (want === "ok" && !outcome.ok)
    problems.push(`expected success, got a refusal: ${outcome.error ?? firstLine(outcome.text)}`);
  if (want === "refused" && outcome.ok) problems.push("expected a refusal, got a success");
  const text = outcome.text.toLowerCase();
  for (const word of step.contains ?? [])
    if (!text.includes(word.toLowerCase())) problems.push(`reply lacks "${word}"`);
  for (const word of step.excludes ?? [])
    if (text.includes(word.toLowerCase())) problems.push(`reply contains "${word}"`);
  return problems;
}

/** The step's command with `{dir}` replaced by the run's scratch folder. */
export function stepCommand(step: PlaybookStep, dir: string): string {
  return step.command.replaceAll("{dir}", dir);
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.slice(0, 200) ?? "";
}
