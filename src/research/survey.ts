// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "../engine/errors";
import { evidenceHash } from "./evidence";
import { availableInstant, type Measurement } from "./measurement";
import { isDateStrict, type Retriever, type Source } from "./retrieve";

export interface SurveyCell {
  subgroup: string;
  population: string;
  response: string;
  value: number;
  /** A base size is not a percentage and never enters a forecast as one. */
  weightedBase?: number;
  unweightedBase?: number;
}

export interface SurveyWave {
  schema: "marina.survey-wave.v1";
  source: string;
  url: string;
  measure: string;
  question: string;
  unit: "percent";
  observedFrom: string;
  observedThrough?: string;
  publishedAt?: string;
  availableAt: string;
  documentHash: string;
  cells: SurveyCell[];
}

/** An explicitly imported, dated table. No fetches or inferred population/response
 * substitutions. Captured artifact identity travels with every table measurement. */
export function surveySource(wave: SurveyWave, cutoff: string): Source {
  if (
    wave.schema !== "marina.survey-wave.v1" ||
    !wave.source ||
    !wave.measure ||
    !wave.question ||
    wave.unit !== "percent" ||
    !/^https?:\/\//.test(wave.url) ||
    !/^[a-f0-9]{64}$/.test(wave.documentHash) ||
    !wave.cells.length ||
    availableInstant(wave.observedFrom) === undefined ||
    Date.parse(wave.observedFrom) > Date.parse(wave.availableAt) ||
    (wave.observedThrough !== undefined &&
      (availableInstant(wave.observedThrough) === undefined ||
        Date.parse(wave.observedThrough) < Date.parse(wave.observedFrom) ||
        Date.parse(wave.observedThrough) > Date.parse(wave.availableAt))) ||
    !Number.isFinite(Date.parse(cutoff)) ||
    availableInstant(wave.availableAt) === undefined ||
    availableInstant(wave.availableAt)! > Date.parse(cutoff)
  )
    throw new Error("invalid or unavailable survey wave");
  const identities = new Set<string>();
  for (const cell of wave.cells) {
    const key = JSON.stringify([cell.population, cell.subgroup, cell.response]);
    if (
      !cell.population ||
      !cell.subgroup ||
      !cell.response ||
      identities.has(key) ||
      !Number.isFinite(cell.value) ||
      cell.value < 0 ||
      cell.value > 100 ||
      [cell.weightedBase, cell.unweightedBase].some(
        (n) => n !== undefined && (!Number.isFinite(n) || n <= 0),
      )
    )
      throw new Error("invalid/duplicate survey cell");
    identities.add(key);
  }
  const text = JSON.stringify(wave);
  const url = `${wave.url.split("#")[0]}#marina-survey-${evidenceHash(wave)}`;
  const measurements: Measurement[] = wave.cells.map((cell) => ({
    measure: wave.measure,
    source: wave.source,
    url,
    origin: wave.url,
    population: cell.population,
    response: cell.response,
    subgroup: cell.subgroup,
    unit: wave.unit,
    value: cell.value,
    quote: JSON.stringify(cell),
    observedFrom: wave.observedFrom,
    observedThrough: wave.observedThrough,
    publishedAt: wave.publishedAt,
    availableAt: wave.availableAt,
  }));
  return {
    url,
    origin: wave.url,
    title: wave.question,
    text,
    observedAt: wave.observedFrom,
    published: wave.publishedAt,
    availableAt: wave.availableAt,
    measurements,
  };
}

export interface ReleaseEvent {
  source: string;
  target: string;
  scheduledAt: string;
  announcedAt: string;
  url: string;
  status: "scheduled" | "delayed" | "published";
}

/** A schedule is a refresh trigger, never evidence that the release already exists. */
export function releasesDue(events: ReleaseEvent[], asOf: string, lastCheckedAt?: string) {
  const now = Date.parse(asOf);
  const prior = lastCheckedAt === undefined ? -Infinity : Date.parse(lastCheckedAt);
  if (!Number.isFinite(now) || (lastCheckedAt !== undefined && !Number.isFinite(prior)))
    throw new Error("invalid calendar bound");
  return events.filter((event) => {
    const scheduled = Date.parse(event.scheduledAt);
    const announced = availableInstant(event.announcedAt) ?? Number.NaN;
    if (
      ![scheduled, announced].every(Number.isFinite) ||
      !event.target ||
      !event.source ||
      !["scheduled", "delayed", "published"].includes(event.status) ||
      !/^https?:\/\//.test(event.url)
    )
      throw new Error("invalid release event");
    return (
      announced <= now &&
      event.status !== "delayed" &&
      scheduled <= now &&
      Math.max(scheduled, announced) > prior
    );
  });
}

/** Reuse permitted, operator-imported table vintages in every research consumer.
 * The newest two available waves retain same-definition changes. The ordinary
 * capture/source policy still validates each supplied artifact before use. */
export function withSurveyEvidence(inner: Retriever, load: () => Promise<SurveyWave[]>): Retriever {
  const wrapped: Retriever = async (brief) => {
    const report = await inner(brief);
    const cutoff =
      brief.untilAt ?? `${brief.until ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    try {
      const waves = await load();
      if (!Array.isArray(waves) || waves.length > 2000)
        throw new Error("survey import must contain at most 2000 waves");
      const matching = waves
        .filter(
          (w) =>
            w.measure === brief.target?.measure &&
            (availableInstant(w.availableAt) ?? Infinity) <= Date.parse(cutoff),
        )
        .sort(
          (a, b) =>
            Date.parse(b.observedFrom) - Date.parse(a.observedFrom) ||
            Date.parse(b.availableAt) - Date.parse(a.availableAt),
        );
      const picked: SurveyWave[] = [];
      for (const wave of matching)
        if (
          !picked.some((p) => p.source === wave.source && p.observedFrom === wave.observedFrom) &&
          picked.filter((p) => p.source === wave.source).length < 2 &&
          picked.length < 20
        )
          picked.push(wave);
      const sources = picked.map((wave) => surveySource(wave, cutoff));
      return {
        ...report,
        sources: [...report.sources, ...sources],
        report: [
          report.report,
          ...sources.flatMap((s) => s.measurements!.map((m) => `${m.quote} [survey](${s.url})`)),
        ].join("\n"),
      };
    } catch (error) {
      return {
        ...report,
        warnings: [
          ...(report.warnings ?? []),
          `Survey evidence unavailable: ${getErrorMessage(error).slice(0, 180)}`,
        ],
      };
    }
  };
  return isDateStrict(inner) ? Object.assign(wrapped, { dateStrict: true as const }) : wrapped;
}

export function withReleaseCalendar(
  inner: Retriever,
  load: () => Promise<ReleaseEvent[]>,
): Retriever {
  const wrapped: Retriever = async (brief) => {
    let events: ReleaseEvent[];
    let planned = brief;
    let warning: string | undefined;
    try {
      events = await load();
      if (!Array.isArray(events) || events.length > 10000)
        throw new Error("invalid release calendar");
      events = events.filter((event) => event.target === brief.roundId);
      const cutoff =
        brief.untilAt ?? `${brief.until ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`;
      const due = releasesDue(events, cutoff, brief.since);
      planned = {
        ...brief,
        releaseEvents: events,
        readFirst: [...new Set([...(brief.readFirst ?? []), ...due.map((e) => e.url)])],
        request: `${brief.request}${due.length ? `\nScheduled releases to verify (not proof of publication): ${due.map((e) => `${e.source} at ${e.scheduledAt}: ${e.url}`).join("; ")}` : ""}`,
      };
    } catch (error) {
      warning = `Release calendar unavailable: ${getErrorMessage(error).slice(0, 180)}`;
    }
    const report = await inner(planned);
    return warning ? { ...report, warnings: [...(report.warnings ?? []), warning] } : report;
  };
  return isDateStrict(inner) ? Object.assign(wrapped, { dateStrict: true as const }) : wrapped;
}
