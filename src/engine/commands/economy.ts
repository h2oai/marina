// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import {
  ECONOMIC_EVENT_KINDS,
  type EconomicEventKind,
  type MarinaDB,
} from "../../persistence/database";
import type { CommandDef, Entity } from "../../types";

const HELP = `Asset-neutral economic provenance (signature-capable claims only; no implied transfer).
Usage:
  economy contract <goal-ref> | <terms JSON> | <verification method> | <dispute method> [| adapter] [| asset-ref]
  economy event <contract> <kind> | <actor-ref> | <subject-ref> | <amount> | <asset-ref> | <external-tx-ref> | <causal refs csv> | <data JSON>
  economy adapter <id> | <kind> | <network> | <reference|observe|submit> [| endpoint-ref] [| configuration-ref]
  economy show <contract>
  economy list
Kinds: ${ECONOMIC_EVENT_KINDS.join(", ")}`;
export function economyCommand(deps: {
  db: MarinaDB;
  getEntity: (id: string) => Entity | undefined;
}): CommandDef {
  return {
    name: "economy",
    aliases: ["contract"],
    category: "Coordination",
    minRank: 0,
    help: HELP,
    handler: (ctx, input) => {
      const actor = deps.getEntity(input.entity);
      if (!actor) return;
      const sub = input.tokens[0]?.toLowerCase();
      const raw = input.args.slice(sub?.length ?? 0).trim();
      if (sub === "contract") {
        const [
          goalRef = "",
          termsText = "",
          verificationMethod = "",
          disputeMethod = "",
          settlementAdapter = "",
          assetRef = "",
          ...extra
        ] = fields(raw);
        if (!goalRef || !termsText || !verificationMethod || !disputeMethod || extra.length) {
          ctx.send(input.entity, HELP);
          return;
        }
        const terms = parseObject(termsText);
        if (!terms) {
          ctx.send(input.entity, "Terms must be a JSON object.");
          return;
        }
        const row = deps.db.createEconomicContract({
          goalRef,
          terms,
          verificationMethod,
          disputeMethod,
          settlementAdapter: settlementAdapter || undefined,
          assetRef: assetRef || undefined,
          createdBy: String(actor.id),
        });
        ctx.send(
          input.entity,
          `Economic contract ${row.id} records terms without compelling participation or moving assets.`,
        );
        return;
      }
      if (sub === "event") {
        const [
          head = "",
          actorRef = "",
          subjectRef = "",
          amount = "",
          assetRef = "",
          externalRef = "",
          causalText = "",
          dataText = "",
          ...extra
        ] = fields(raw);
        const [selector, kind, ...headExtra] = head.split(/\s+/);
        const contract = deps.db.getEconomicContract(selector ?? "");
        if (!contract || !isKind(kind) || headExtra.length || !actorRef || extra.length) {
          ctx.send(input.entity, HELP);
          return;
        }
        const data = parseObject(dataText);
        if (!data) {
          ctx.send(input.entity, "Event data must be a JSON object.");
          return;
        }
        const row = deps.db.appendEconomicEvent({
          contractId: contract.id,
          kind,
          actorRef,
          subjectRef: subjectRef || undefined,
          amount: amount || undefined,
          assetRef: assetRef || undefined,
          externalRef: externalRef || undefined,
          causalRefs: causalText
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          data,
        });
        ctx.send(
          input.entity,
          `Recorded ${row.kind} ${row.id}${externalRef ? ` referencing ${externalRef}` : ""}. This is provenance, not proof of payment or rights.`,
        );
        return;
      }
      if (sub === "adapter") {
        const [
          id = "",
          kind = "",
          network = "",
          capability = "",
          endpointRef = "",
          configurationRef = "",
          ...extra
        ] = fields(raw);
        if (
          !id ||
          !kind ||
          !network ||
          !["reference", "observe", "submit"].includes(capability) ||
          extra.length
        ) {
          ctx.send(input.entity, HELP);
          return;
        }
        if (!SAFE_ADAPTER_ID.test(id)) {
          ctx.send(
            input.entity,
            "Adapter id must be 3-64 chars: letters, digits, and : . _ - (starting alphanumeric).",
          );
          return;
        }
        if (deps.db.listEconomicAdapters().some((adapter) => adapter.id === id)) {
          ctx.send(input.entity, `Adapter ${id} already exists.`);
          return;
        }
        const row = deps.db.createEconomicAdapter({
          id,
          kind,
          network,
          capability: capability as "reference" | "observe" | "submit",
          endpointRef: endpointRef || undefined,
          configurationRef: configurationRef || undefined,
          createdBy: String(actor.id),
        });
        ctx.send(
          input.entity,
          `Adapter ${row.id} declared for ${row.network}; no credentials or funds were stored.`,
        );
        return;
      }
      if (sub === "show") {
        const row = deps.db.getEconomicContract(input.tokens[1] ?? "");
        if (!row) {
          ctx.send(input.entity, "Economic contract not found.");
          return;
        }
        // Cap the displayed/verified window — per-event Ed25519 verification on
        // a rank-0 command must not scale with unbounded ledger growth.
        const events = deps.db.listEconomicEvents(row.id).slice(-100);
        ctx.send(
          input.entity,
          `${row.id} · goal ${row.goal_ref}\nAsset: ${row.asset_ref ?? "none"} via ${row.settlement_adapter ?? "no adapter"}\nVerification: ${row.verification_method}\nDispute: ${row.dispute_method}\nEvents (newest ${events.length}):\n${
            events
              .map((event) => {
                const signature = event.signature_json
                  ? deps.db.verifyEconomicEvent(event).valid
                    ? "signature verified"
                    : "INVALID signature"
                  : "unsigned";
                return `  ${event.kind} · ${event.actor_ref} · ${event.external_ref ?? "local claim"} · ${signature}`;
              })
              .join("\n") || "  none"
          }`,
        );
        return;
      }
      if (sub === "list" || !sub) {
        const rows = deps.db.listEconomicContracts();
        ctx.send(
          input.entity,
          rows.length
            ? rows.map((r) => `${r.id} · ${r.goal_ref} · ${r.asset_ref ?? "unfunded"}`).join("\n")
            : "No economic contracts. Marina remains fully usable without settlement.",
        );
        return;
      }
      ctx.send(input.entity, HELP);
    },
  };
}
const SAFE_ADAPTER_ID = /^[a-z0-9][a-z0-9:._-]{2,63}$/i;

function fields(raw: string) {
  return raw.split("|").map((x) => x.trim());
}
function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  return undefined;
}
function isKind(v: string | undefined): v is EconomicEventKind {
  return ECONOMIC_EVENT_KINDS.includes(v as EconomicEventKind);
}
