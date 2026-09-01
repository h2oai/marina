// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JourneyEventRow } from "../persistence/database";

export type JourneyState =
  | "expressed"
  | "grounding"
  | "ready"
  | "active"
  | "waiting"
  | "challenging"
  | "useful_result"
  | "continuing"
  | "dormant";

export interface JourneyWorkEvidence {
  kind: "task" | "project";
  ref: string;
  status: string;
  updatedAt: number;
}

export interface JourneyStateProjection {
  state: JourneyState;
  changedAt: number;
  reason: string;
  evidence: string[];
}

const EVENT_STATE: Partial<Record<JourneyEventRow["kind"], JourneyState>> = {
  interpretation: "grounding",
  grounding: "grounding",
  action_started: "active",
  evidence: "active",
  challenge: "challenging",
  result: "useful_result",
  waiting: "waiting",
  continuation: "continuing",
  dormant: "dormant",
  resumed: "active",
};

/**
 * Project a journey's current state from append-only evidence and linked live
 * work. This function owns no state: the same inputs always produce the same
 * result, so callers can explain and test every transition.
 */
export function projectJourneyState(input: {
  createdAt: number;
  events: readonly JourneyEventRow[];
  work?: readonly JourneyWorkEvidence[];
}): JourneyStateProjection {
  const work = input.work ?? [];
  const activeWork = newestWork(work, new Set(["claimed", "in_progress", "running"]));
  const readyWork = newestWork(work, new Set(["open", "active", "pending"]));
  const latestEvent = newestEvent(input.events);

  // A live work record can supersede an older lifecycle assertion. Conversely,
  // an explicit later dormant/waiting event remains authoritative even if a
  // linked task was never cleaned up.
  if (activeWork && (!latestEvent || activeWork.updatedAt > latestEvent.created_at)) {
    return {
      state: "active",
      changedAt: activeWork.updatedAt,
      reason: `linked ${activeWork.kind} ${activeWork.ref} is ${activeWork.status}`,
      evidence: [workRef(activeWork)],
    };
  }

  if (latestEvent) {
    const state = EVENT_STATE[latestEvent.kind];
    if (state) {
      return {
        state,
        changedAt: latestEvent.created_at,
        reason: latestEvent.summary,
        evidence: [eventRef(latestEvent)],
      };
    }
  }

  if (activeWork) {
    return {
      state: "active",
      changedAt: activeWork.updatedAt,
      reason: `linked ${activeWork.kind} ${activeWork.ref} is ${activeWork.status}`,
      evidence: [workRef(activeWork)],
    };
  }

  if (readyWork) {
    return {
      state: "ready",
      changedAt: readyWork.updatedAt,
      reason: `linked ${readyWork.kind} ${readyWork.ref} is ${readyWork.status}`,
      evidence: [workRef(readyWork)],
    };
  }

  return {
    state: "expressed",
    changedAt: input.createdAt,
    reason: "the original desire has been preserved; no later journey evidence exists",
    evidence: ["journey:created"],
  };
}

function newestEvent(events: readonly JourneyEventRow[]): JourneyEventRow | undefined {
  return events.reduce<JourneyEventRow | undefined>((latest, event) => {
    if (!latest) return event;
    if (event.created_at !== latest.created_at) {
      return event.created_at > latest.created_at ? event : latest;
    }
    return event.id > latest.id ? event : latest;
  }, undefined);
}

function newestWork(
  work: readonly JourneyWorkEvidence[],
  statuses: ReadonlySet<string>,
): JourneyWorkEvidence | undefined {
  return work
    .filter((item) => statuses.has(item.status))
    .reduce<JourneyWorkEvidence | undefined>(
      (latest, item) => (!latest || item.updatedAt > latest.updatedAt ? item : latest),
      undefined,
    );
}

function eventRef(event: JourneyEventRow): string {
  return `journey_event:${event.id}`;
}

function workRef(work: JourneyWorkEvidence): string {
  return `${work.kind}:${work.ref}`;
}
