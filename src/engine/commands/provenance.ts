// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator, status } from "../../net/ansi";
import { federationSigningAvailable } from "../../net/federation-crypto";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef } from "../../types";

export function provenanceCommand(db: MarinaDB): CommandDef {
  return {
    name: "provenance",
    aliases: ["cognition-log"],
    category: "Cognition",
    minRank: 0,
    help: "Inspect the optional cognitive provenance ledger. Usage: provenance [status|list [journey-id]|verify]",
    handler: (ctx, input) => {
      const sub = input.tokens[0]?.toLowerCase() ?? "status";
      if (sub === "status") {
        const enabled = process.env.MARINA_COGNITIVE_PROVENANCE === "true";
        ctx.send(
          input.entity,
          [
            header("Cognitive provenance"),
            separator(),
            `${bold("Capture:")} ${enabled ? status("OPT IN", "active") : status("OFF", "info")}`,
            `${bold("Signing:")} ${federationSigningAvailable() ? "Ed25519 configured" : "unsigned hash chain"}`,
            `${bold("Events:")} ${db.listCognitiveEvents({ limit: 1000 }).length}`,
            dim(
              "This plane is separate from legacy traces. A signature proves integrity and key possession, not truth.",
            ),
          ].join("\n"),
        );
        return;
      }
      if (sub === "list") {
        const journeyId = input.tokens[1];
        const events = db.listCognitiveEvents({ journeyId, limit: 100 });
        const lines = [header("Cognitive events"), separator()];
        if (events.length === 0) lines.push("No matching cognitive events.");
        for (const event of events) {
          lines.push(
            `  #${event.sequence} ${event.kind} ${dim(event.id)}`,
            `    ${event.actor_id}${event.journey_id ? ` · ${event.journey_id}` : ""} · ${event.event_hash}`,
          );
        }
        ctx.send(input.entity, lines.join("\n"));
        return;
      }
      if (sub === "verify") {
        const events = db.listCognitiveEvents({ limit: 1000 });
        const chronological = [...events].reverse();
        let previous: string | null = chronological[0]?.previous_hash ?? null;
        let invalid = 0;
        for (const event of chronological) {
          const verification = db.verifyCognitiveEvent(event);
          if (!verification.valid || event.previous_hash !== previous) invalid++;
          previous = event.event_hash;
        }
        ctx.send(
          input.entity,
          invalid === 0
            ? `Verified ${events.length} cognitive events and their hash-chain continuity.`
            : `Verification failed for ${invalid} of ${events.length} cognitive events.`,
        );
        return;
      }
      ctx.send(input.entity, "Usage: provenance [status|list [journey-id]|verify]");
    },
  };
}
