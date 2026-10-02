// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { canvasDocumentData, panelRevision } from "../engine/canvas-document";
import { commandManifest } from "../engine/command-manifest";
import type { Engine } from "../engine/engine";
import { getErrorMessage } from "../engine/errors";
import type { MarinaDB } from "../persistence/database";
import { RoutingError } from "../routing/errors";
import { RoutingService } from "../routing/service";
import { composeCommand } from "../sdk/command-forms";
import { panelInput, parsePanelOperation } from "../sdk/panel-actions";
import { panelRecord, validatePanelDocument } from "../sdk/panel-document";
import type { StorageProvider } from "../storage/provider";
import type { EntityId } from "../types";
import { authenticateRequest } from "./auth-middleware";
import type { CanvasBroadcaster } from "./canvas-ws";
import { authorizePrivileged } from "./dashboard-api/shared";
import { readJsonBody } from "./http-utils";

interface InteractionContext {
  req: Request;
  db: MarinaDB;
  storage?: StorageProvider;
  broadcaster?: CanvasBroadcaster;
  engine?: Engine;
  entityId?: EntityId;
  canvasId: string;
  nodeId: string;
  canAccess: () => boolean;
  json: (data: unknown, status?: number) => Response;
  enrich: (
    node: { asset_id: string | null; data: string },
    data: Record<string, unknown>,
  ) => Record<string, unknown>;
}
/** Definitions carry no authority. Each click is authenticated again at execution. */
export async function handlePanelInteraction(ctx: InteractionContext): Promise<Response> {
  const { req, db, storage, broadcaster, engine, entityId, canvasId, nodeId, json } = ctx;
  if (!ctx.canAccess()) return json({ error: "Panel not found" }, 404);
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  const body = read.body;
  const node = db.getNode(nodeId);
  if (!node || node.canvas_id !== canvasId || node.type !== "a2ui")
    return json({ error: "Panel not found" }, 404);
  const current = () => {
    if (engine) {
      const auth = authenticateRequest(req, engine);
      if ("error" in auth || auth.entityId !== entityId)
        throw new RoutingError(401, "signed_out", "Sign in again before acting.");
    }
    const latest = db.getNode(nodeId);
    if (
      !ctx.canAccess() ||
      !latest ||
      latest.data !== node.data ||
      latest.asset_id !== node.asset_id
    )
      throw new RoutingError(409, "panel_changed", "Panel changed. Refresh before submitting.");
  };
  try {
    const data = await canvasDocumentData(JSON.parse(node.data), node.asset_id, db, storage);
    current();
    if (typeof body.revision !== "string" || body.revision !== panelRevision(data))
      throw new RoutingError(409, "panel_changed", "Panel changed. Refresh before submitting.");
    const parsed = validatePanelDocument(data);
    if (!parsed.ok) throw new Error(parsed.error);
    const component = parsed.document.components.find((c) => c.id === body.componentId);
    if (!component || component.disabled) throw new Error("Action unavailable");
    const operation = parsePanelOperation(component.operation);
    if (operation) {
      if (!engine || !entityId)
        return json({ error: "An authenticated world participant is required." }, 403);
      const rawFields = body.fields ?? {};
      if (!panelRecord(rawFields) || Object.keys(rawFields).length > 128)
        throw new Error("Invalid fields");
      const fields: Record<string, string | boolean> = {};
      for (const [id, value] of Object.entries(rawFields)) {
        const field = parsed.document.components.find((c) => c.id === id);
        if (
          !field ||
          !["TextField", "DateTimeInput", "CheckBox"].includes(field.component) ||
          (field.component === "CheckBox"
            ? typeof value !== "boolean"
            : typeof value !== "string" || value.length > 16384)
        )
          throw new Error("Invalid field value");
        fields[id] = value as string | boolean;
      }
      if (operation.kind !== "command") {
        if (typeof body.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId))
          throw new Error("A stable requestId is required.");
        const clientMessageId = `panel:${createHash("sha256")
          .update(JSON.stringify([nodeId, component.id, body.revision, body.requestId]))
          .digest("hex")}`;
        const router = new RoutingService(db, db.durableEntityKey(entityId));
        let receipt: ReturnType<RoutingService["send"]>;
        if (operation.kind === "message") {
          const message = panelInput(operation.message, fields);
          if (typeof message !== "string" || !message.trim()) throw new Error("Enter a message.");
          if (typeof body.sourceId !== "string")
            throw new Error("Choose your sending participant.");
          receipt = router.send(body.sourceId, {
            targetId: operation.targetId,
            clientMessageId,
            kind: "message",
            payload: { text: message },
          });
        } else {
          const denied = authorizePrivileged(engine, db, entityId, "code.exec");
          if (denied) return denied;
          const values = Object.fromEntries(
            Object.entries(operation.values ?? {}).map(([key, value]) => [
              key,
              panelInput(value, fields),
            ]),
          );
          if (
            operation.control === "prompt" &&
            (typeof values.text !== "string" || !values.text.trim())
          )
            throw new Error("Enter a prompt.");
          if (
            operation.control === "respond" &&
            (typeof values.requestId !== "string" ||
              typeof values.allow !== "boolean" ||
              (values.answer !== undefined && typeof values.answer !== "string"))
          )
            throw new Error("A current request and explicit decision are required.");
          receipt = router.control(operation.targetId, {
            targetId: operation.targetId,
            clientMessageId,
            control: { ...values, action: operation.control },
          });
        }
        return json({
          status: receipt.status,
          receipt,
          message: "Delivery recorded. Acknowledgment does not mean the work is complete.",
        });
      }
      // Use the entity's existing FIFO. Recheck after queueing, since a panel or
      // a room's command form may change while another command is running.
      const result = Promise.withResolvers<Response>();
      let started = false;
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        result.resolve(
          json(
            {
              error: started
                ? "Command outcome is uncertain. Inspect world activity before retrying."
                : "Command expired before execution.",
            },
            504,
          ),
        );
      }, 30000);
      const admitted = engine.submitCommand(entityId, `panel ${nodeId}`, async () => {
        if (expired || req.signal.aborted) {
          clearTimeout(timer);
          result.resolve(json({ error: "Command cancelled before execution." }, 408));
          return;
        }
        started = true;
        try {
          current();
          const entry = commandManifest(engine.commands, {
            roomCommands: engine.getEntityRoom(entityId)?.module.commands,
          }).find((c) => c.name === operation.command);
          const form = entry?.forms?.find((f) => f.syntax === operation.syntax);
          if (!form || body.capabilityRevision !== engine.commands.revision)
            throw new RoutingError(
              409,
              "capabilities_changed",
              "Command capabilities changed. Review the current form.",
            );
          const values = Object.fromEntries(
            Object.entries(operation.values ?? {}).map(([key, value]) => [
              key,
              String(panelInput(value, fields)),
            ]),
          );
          const enabled = operation.enabled ?? [];
          if (
            Object.keys(values).some((key) => !form.fields.some((f) => f.id === key)) ||
            enabled.some((key) => !form.groups.some((g) => g.id === key))
          )
            throw new Error("Unknown field or optional group.");
          if (
            enabled.some((id) => {
              const parent = form.groups.find((g) => g.id === id)?.parent;
              return parent && !enabled.includes(parent);
            })
          )
            throw new Error("Enable parent groups first.");
          const composed = composeCommand(
            form,
            values,
            Object.fromEntries(enabled.map((id) => [id, true])),
          );
          if (Object.keys(composed.errors).length) throw new Error(JSON.stringify(composed.errors));
          if (engine.rateLimiter && !engine.rateLimiter.consume(entityId))
            throw new RoutingError(429, "rate_limited", "Rate limited. Please slow down.");
          await engine.processCommand(entityId, composed.command, {
            bypassModal: true,
            codingTarget: operation.codingTarget,
          });
          result.resolve(
            json({
              status: "processed",
              message: "Command processed. Its result is in your world conversation.",
            }),
          );
        } catch (error) {
          result.resolve(
            json(
              { error: getErrorMessage(error) },
              error instanceof RoutingError ? error.status : 400,
            ),
          );
        } finally {
          clearTimeout(timer);
        }
      });
      if (!admitted) {
        clearTimeout(timer);
        return json({ error: "World command capacity reached." }, 503);
      }
      return await result.promise;
    }
    let event: { name: string; payload?: Record<string, unknown> };
    if (
      component.component === "Button" &&
      panelRecord(component.action) &&
      panelRecord(component.action.event)
    )
      event = component.action.event as typeof event;
    else if (["TextField", "DateTimeInput", "CheckBox"].includes(component.component)) {
      if (
        component.component === "CheckBox"
          ? typeof body.value !== "boolean"
          : typeof body.value !== "string" || body.value.length > 16384
      )
        throw new Error("Invalid field value");
      event = {
        name: "field_change",
        payload: { fieldId: component.fieldId ?? component.id, value: body.value },
      };
    } else throw new Error("Action unavailable");
    const updated = { ...data, lastAction: { ...event, timestamp: Date.now() } };
    db.updateNode(nodeId, { data: JSON.stringify(updated) });
    const latest = db.getNode(nodeId)!;
    const enriched = { ...latest, data: ctx.enrich(latest, updated) };
    broadcaster?.broadcast({ type: "node_updated", canvasId, nodeId, changes: enriched });
    return json({ status: "saved", node: enriched });
  } catch (error) {
    return json(
      { error: getErrorMessage(error) },
      error instanceof RoutingError ? error.status : 400,
    );
  }
}
