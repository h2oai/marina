const MAX_CANVAS_REFERENCE_LENGTH = 200;

function boundedReference(value: string | null): string | undefined {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.length > MAX_CANVAS_REFERENCE_LENGTH ||
    [...normalized].some((character) => character.charCodeAt(0) < 32)
  ) {
    return undefined;
  }
  return normalized;
}

export interface CanvasSelection {
  canvasId?: string;
  nodeId?: string;
  edgeId?: string;
}

export function canvasSelectionFromSearch(search: string): CanvasSelection {
  const params = new URLSearchParams(search);
  return {
    canvasId: boundedReference(params.get("canvas")),
    nodeId: boundedReference(params.get("node")),
    edgeId: boundedReference(params.get("edge")),
  };
}

export function canvasPermalink(
  selection: CanvasSelection,
  currentUrl: string,
  path = "/canvas",
): string {
  const url = new URL(currentUrl);
  url.pathname = path;
  url.hash = "";
  url.search = "";
  if (selection.canvasId) url.searchParams.set("canvas", selection.canvasId);
  if (selection.nodeId) url.searchParams.set("node", selection.nodeId);
  if (selection.edgeId) url.searchParams.set("edge", selection.edgeId);
  return `${url.pathname}${url.search}`;
}
