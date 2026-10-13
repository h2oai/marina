// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { claimIntent, completeIntent, failIntent } from "../../coordination/canvas-intents";
import { header, separator } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import { CANVAS_INTENT_CLAIM_TIMEOUT_MS, type CanvasNodeRow } from "../../persistence/db-canvas";
import { validatePanelDocument } from "../../sdk/panel-document";
import type { Entity, EntityId, RoomContext } from "../../types";
import { type CanvasReader, mayReadCanvas } from "../canvas-access";

/** Command parsing/presentation only; lifecycle writes also serve the HTTP UI. */
export async function handleCanvasIntent(options: {
  ctx: RoomContext;
  entity: Entity;
  db: MarinaDB;
  tokens: string[];
  reader: CanvasReader;
  resolveWritableNode: (id: string) => CanvasNodeRow | undefined;
  preview: (assetId: string | null) => Promise<string | undefined>;
  resultTypes: string[];
  logEvent?: (event: { type: string; entity: EntityId; [key: string]: unknown }) => void;
}): Promise<void> {
  const { ctx, entity, db, tokens, reader, resolveWritableNode, preview, resultTypes, logEvent } =
    options;
  const send = (text: string) => ctx.send(entity.id, text);
  const action = tokens[0]?.toLowerCase();
  const usage =
    "Usage: canvas intent list [canvas] | canvas intent claim <node_id> | canvas intent fail <node_id> [reason] | canvas intent complete <node_id> [--type <type>] <result> | canvas intent complete-rich <node_id> <a2ui_json>";
  if (action === "list") {
    const items = db
      .listCanvasIntents({
        canvasName: tokens[1],
        statuses: ["pending", "active"],
        limit: 100,
        expireActiveMs: CANVAS_INTENT_CLAIM_TIMEOUT_MS,
      })
      .filter((item) => mayReadCanvas(db.getCanvas(item.canvasId), reader));
    send(
      items.length
        ? [
            header("Canvas Intents"),
            separator(),
            ...items.map((item) => {
              const claimed = item.intent.claimedBy ? ` [${item.intent.claimedBy}]` : "";
              const prompt =
                item.intent.prompt.length > 60
                  ? `${item.intent.prompt.slice(0, 57)}...`
                  : item.intent.prompt;
              return `  ${item.nodeId.slice(0, 8)}.. [${item.intent.status}]${claimed} ${item.canvasName}/${item.type} — "${prompt}"`;
            }),
          ].join("\n")
        : "No pending or active intents found.",
    );
    return;
  }
  if (!action || !["claim", "fail", "complete", "complete-rich"].includes(action) || !tokens[1]) {
    send(usage);
    return;
  }
  const node = resolveWritableNode(tokens[1]);
  if (!node) {
    send(`Node "${tokens[1]}" not found.`);
    return;
  }
  const context = { db, actor: { id: entity.id, name: entity.name, room: entity.room }, logEvent };
  const reportFailure = (failure: { reason: string; status?: string }) => {
    if (failure.reason === "no_intent") send("This node has no intent.");
    else if (failure.reason === "not_found") send(`Node "${tokens[1]}" not found.`);
    else send(`Intent is already "${failure.status ?? "changed"}", cannot ${action}.`);
  };
  if (action === "claim") {
    const result = claimIntent(context, node.id);
    if (!result.ok) {
      reportFailure(result);
      return;
    }
    const attachment = await preview(node.asset_id);
    send(
      `Claimed intent on node ${node.id.slice(0, 8)}.. — "${result.intent.prompt}"${attachment ? `\n\n${attachment}` : ""}`,
    );
    return;
  }
  if (action === "fail") {
    const reason = tokens.slice(2).join(" ") || "No reason given";
    const result = failIntent(context, node.id, reason);
    if (!result.ok) {
      reportFailure(result);
      return;
    }
    send(`Intent failed on node ${node.id.slice(0, 8)}.. Reason: ${reason}`);
    return;
  }
  let resultType = "text";
  let resultTokens = tokens.slice(2);
  const typeIndex = resultTokens.indexOf("--type");
  if (action === "complete" && typeIndex !== -1 && resultTokens[typeIndex + 1]) {
    resultType = resultTokens[typeIndex + 1]!;
    resultTokens = [...resultTokens.slice(0, typeIndex), ...resultTokens.slice(typeIndex + 2)];
  }
  if (!resultTypes.includes(resultType)) {
    send(`Invalid result node type. Valid: ${resultTypes.join(", ")}`);
    return;
  }
  let text = resultTokens.join(" ");
  if (!text) {
    send(usage);
    return;
  }
  let resultData: Record<string, unknown> | undefined;
  if (action === "complete-rich") {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      send("Invalid JSON. Provide a valid A2UI component tree.");
      return;
    }
    const document = validatePanelDocument(raw);
    if (!document.ok) {
      send(document.error);
      return;
    }
    resultData = { ...document.document };
    resultType = "a2ui";
    text = "[A2UI]";
  }
  const result = completeIntent(context, node.id, { result: text, resultType, resultData });
  if (!result.ok) {
    reportFailure(result);
    return;
  }
  send(
    action === "complete-rich"
      ? `Intent completed with A2UI result on node ${node.id.slice(0, 8)}.. Result: ${result.resultNode.id.slice(0, 8)}..`
      : `Intent completed on node ${node.id.slice(0, 8)}.. Result published as ${resultType} child node ${result.resultNode.id.slice(0, 8)}..`,
  );
}
