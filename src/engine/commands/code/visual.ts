// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { admitVisualLook, sniffRaster, visionMaxBytes } from "../../media/vision";
import {
  type CodeDeps,
  canAdoptCodingSession,
  resolveSession,
  sendCode,
  updateCodeContext,
} from "./shared";
import { getWorkspaceRegistry, workspaceForSession } from "./workspace";

/** Workspace images use the normal session/root grants; no scratch copies or public assets. */
export async function seeWorkspaceFile(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  raw: string,
  args: string[],
): Promise<void> {
  const input = raw.trim().startsWith("{")
    ? (JSON.parse(raw) as { path?: unknown; question?: unknown })
    : { path: args[0], question: args.slice(1).join(" ") };
  if (
    typeof input.path !== "string" ||
    !input.path.trim() ||
    /[\0\r\n]/.test(input.path) ||
    (input.question !== undefined && typeof input.question !== "string")
  )
    throw new Error("Usage: code see <path> [question]");
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  if (!canAdoptCodingSession(session, entity))
    throw new Error("This coding session is not authorized.");
  if (session.execution_target !== "local")
    throw new Error(
      "Workspace image reads are unavailable for this execution target; no host fallback.",
    );
  if (!getWorkspaceRegistry(deps).hostExecAllowed)
    throw new Error("Workspace vision requires an operator-configured code root.");
  const workspace = workspaceForSession(deps, session);
  if (!workspace.readBytes || !deps.describeVisual)
    throw new Error("Workspace vision is unavailable.");
  const source = await workspace.readBytes(input.path, visionMaxBytes());
  const mime = sniffRaster(source.data);
  if (!mime)
    throw new Error("Workspace vision accepts PNG, JPEG, GIF or WebP images, verified by content.");
  const question = (input.question as string | undefined)?.trim() ?? "";
  admitVisualLook(eid);
  const result = await deps.describeVisual(
    { ...source, mime, label: source.path },
    question,
    entity,
  );
  // Save the full result before returning: compression or a disconnected client cannot erase it.
  const metadata = {
    sourcePath: source.path,
    sourceSha256: createHash("sha256").update(source.data).digest("hex"),
    question,
    model: result.model,
    notes: result.notes,
    cached: !!result.cached,
    evidenceTrust: "untrusted",
    workspace: workspace.displayRoot(),
  };
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "visual_evidence",
    title: `Image observation: ${source.path}`,
    status: result.ok ? "complete" : "failed",
    contentText: result.text,
    metadata,
    createdBy: entity.name,
  });
  updateCodeContext(entity, deps.db, session);
  sendCode(
    ctx,
    eid,
    `${result.ok ? "" : "[no vision] "}${result.text}\nSaved observation: ${artifact.id}. Reopen with code show ${artifact.id}; no new vision call.`,
    {
      type: "artifact",
      event: "visual_evidence",
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      title: artifact.title,
      content: result.text,
      status: artifact.status,
      sessionId: session.id,
      metadata,
      commands: [`code show ${artifact.id}`, "code artifacts kind visual_evidence"],
    },
  );
}
