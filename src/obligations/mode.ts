// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `MARINA_OBLIGATIONS=off|observe|on` — the obligations ledger for Marina's own
 * agent loops (residents, crews, Code Mode coders). Default `off`: nothing is
 * extracted, no call is made, prompts are unchanged. `observe` extracts and
 * tracks (and logs counts) without showing anything to the model; `on` also
 * lists open obligations in the continuation prompt and nudges a run that
 * would end with one open (once per obligation).
 *
 * The `/v1` passthru never reads this: a request opts in itself
 * (`marina/obligations:<model>` or `x-marina-obligations: on|observe`).
 */
export type ObligationsMode = "off" | "observe" | "on";

export function parseObligationsMode(raw: string | undefined | null): ObligationsMode | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1") return "on";
  if (v === "observe") return "observe";
  if (v === "off" || v === "false" || v === "0") return "off";
  return undefined;
}

export function obligationsMode(env: NodeJS.ProcessEnv = process.env): ObligationsMode {
  return parseObligationsMode(env.MARINA_OBLIGATIONS) ?? "off";
}

/**
 * The model the ledger's own calls (extraction, judging) use:
 * `MARINA_OBLIGATIONS_MODEL`, else undefined — the surface then uses the model
 * already serving the work, so one model is enough.
 */
export function obligationsModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.MARINA_OBLIGATIONS_MODEL?.trim() || undefined;
}

/**
 * `MARINA_ARGCHECK=off|observe|on` — the argument check before a state-changing
 * tool call in Marina's own agent loops (`argcheck.ts`). Default `off`: nothing
 * is checked. `observe` checks and logs counts; `on` also refuses a call whose
 * arguments the conversation does not support, once per call signature, with
 * the reason (the model decides what to send next).
 *
 * The `/v1` passthru never reads this: a request opts in itself
 * (`marina/argcheck:<model>` or `x-marina-argcheck: on|observe`).
 */
export function argcheckMode(env: NodeJS.ProcessEnv = process.env): ObligationsMode {
  return parseObligationsMode(env.MARINA_ARGCHECK) ?? "off";
}

/**
 * The model the argument check's judge uses when no decision layer is
 * configured: `MARINA_ARGCHECK_MODEL`, else `MARINA_OBLIGATIONS_MODEL`, else
 * undefined (the surface then uses the model already serving the work).
 */
export function argcheckModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.MARINA_ARGCHECK_MODEL?.trim() || obligationsModel(env);
}
