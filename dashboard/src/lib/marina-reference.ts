import type { DashboardEvent } from "./types";

export type MarinaReference =
  | { kind: "trace"; id: string; spanId?: string }
  | { kind: "task"; id: string }
  | { kind: "canvas"; id: string }
  | { kind: "canvas_node"; id: string; canvasId: string };

function dashboardUrl(currentUrl: string): URL {
  const url = new URL(currentUrl);
  url.pathname = "/dashboard";
  url.search = "";
  url.hash = "";
  return url;
}

export function marinaReferenceHref(reference: MarinaReference, currentUrl: string): string {
  const url = dashboardUrl(currentUrl);
  switch (reference.kind) {
    case "trace":
      url.searchParams.set("trace", reference.id);
      if (reference.spanId) url.searchParams.set("span", reference.spanId);
      break;
    case "task":
      url.searchParams.set("inspect", `task:${reference.id}`);
      break;
    case "canvas":
      url.pathname = "/canvas";
      url.searchParams.set("canvas", reference.id);
      break;
    case "canvas_node":
      url.pathname = "/canvas";
      url.searchParams.set("canvas", reference.canvasId);
      url.searchParams.set("node", reference.id);
      break;
  }
  return `${url.pathname}${url.search}`;
}

/** Resolve the most useful concrete object represented by an engine event. */
export function primaryReferenceForEvent(event: DashboardEvent): MarinaReference | undefined {
  if (event.type.startsWith("task_") && event.taskId != null) {
    return { kind: "task", id: String(event.taskId) };
  }
  if (event.type === "canvas_intent" && event.canvasId && event.nodeId) {
    return { kind: "canvas_node", canvasId: event.canvasId, id: event.nodeId };
  }
  if (event.traceId) {
    return { kind: "trace", id: event.traceId, spanId: event.spanId };
  }
  return undefined;
}

export type DashboardInspection =
  | { type: "task"; id: number }
  | { type: "board"; name: string }
  | { type: "group"; name: string }
  | { type: "channel"; name: string }
  | { type: "project"; id: string };

export function dashboardInspectionFromSearch(search: string): DashboardInspection | undefined {
  const raw = new URLSearchParams(search).get("inspect")?.trim();
  if (!raw || raw.length > 300) return undefined;
  const colon = raw.indexOf(":");
  if (colon < 1) return undefined;
  const kind = raw.slice(0, colon);
  const id = raw.slice(colon + 1).trim();
  if (!id) return undefined;
  if (kind === "task") {
    const parsed = Number(id);
    return Number.isSafeInteger(parsed) && parsed > 0 ? { type: "task", id: parsed } : undefined;
  }
  if (kind === "board" || kind === "group" || kind === "channel") {
    return { type: kind, name: id };
  }
  if (kind === "project") return { type: "project", id };
  return undefined;
}
