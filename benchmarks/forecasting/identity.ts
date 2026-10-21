// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whose name a competition submission is filed under.
 *
 * Marina ships no default identity: a FutureX file, a ForecastBench set or a
 * Metaculus comment names the organization and agent the OPERATOR chose, never
 * the maintainers'. An adapter asks `filingIdentity()` before it produces or
 * files a submission, and refuses (with the flag and variable to set) until
 * one is given. Placeholders from the docs (`your-org`, `your-agent`, …) are
 * refused too, so a copied example never files under a placeholder.
 */

/** The environment variables an operator sets once for every adapter. */
export const IDENTITY_ENV = {
  organization: "MARINA_FILING_ORG",
  agent: "MARINA_FILING_AGENT",
} as const;

export interface FilingIdentity {
  /** The organization (or person) the submission is filed under. */
  organization: string;
  /** The agent / entrant name shown on the board. */
  agent: string;
}

/** A value copied from the docs' examples rather than chosen. */
export function isPlaceholderIdentity(value: string): boolean {
  return /^(<[^>]*>|your\b[\w .-]*|example\b[\w .-]*|changeme|todo)$/i.test(value.trim());
}

export class MissingIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingIdentityError";
  }
}

/**
 * Check an identity a caller built itself (library use): both parts present
 * and neither a placeholder. Throws `MissingIdentityError` otherwise.
 */
export function assertFilingIdentity(
  adapter: string,
  id: Partial<FilingIdentity> | undefined,
): FilingIdentity {
  return filingIdentity({ adapter, org: id?.organization ?? "", agent: id?.agent ?? "", env: {} });
}

export interface IdentityInput {
  /** The adapter, for the message (`futurex`, `forecastbench`, `metaculus`). */
  adapter: string;
  /** Values given on the command line (they win over the environment). */
  org?: string;
  agent?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The operator's filing identity, from `--org`/`--agent` or
 * `MARINA_FILING_ORG`/`MARINA_FILING_AGENT`. Throws `MissingIdentityError`
 * naming what to set when either is missing or still a placeholder.
 */
export function filingIdentity(input: IdentityInput): FilingIdentity {
  const env = input.env ?? process.env;
  const organization = (input.org ?? env[IDENTITY_ENV.organization] ?? "").trim();
  const agent = (input.agent ?? env[IDENTITY_ENV.agent] ?? "").trim();
  const problems: string[] = [];
  if (!organization) problems.push(`--org <your-org> (or ${IDENTITY_ENV.organization})`);
  else if (isPlaceholderIdentity(organization))
    problems.push(`--org: "${organization}" is a placeholder, not an organization`);
  if (!agent) problems.push(`--agent <your-agent> (or ${IDENTITY_ENV.agent})`);
  else if (isPlaceholderIdentity(agent))
    problems.push(`--agent: "${agent}" is a placeholder, not an agent name`);
  if (problems.length) {
    throw new MissingIdentityError(
      `${input.adapter}: no filing identity — set ${problems.join(" and ")}. ` +
        "Marina ships no default identity; a submission is filed under the name you give.",
    );
  }
  return { organization, agent };
}
