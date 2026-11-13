// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `code improve`: what the self-improvement work finder sees in this server's
 * own log (src/engine/self-improve.ts) and which fix tasks it filed.
 */
import type { MarinaDB } from "../../../persistence/database";
import type { EntityId, RoomContext } from "../../../types";
import { finderState, recurringSignals, selfImproveMode } from "../../self-improve";
import { sendCode } from "./shared";

export function improveCode(ctx: RoomContext, eid: EntityId, db: MarinaDB): void {
  const mode = selfImproveMode();
  const state = finderState(db);
  const live = mode === "off" ? [] : recurringSignals(db).filter((s) => !(s.key in state.filed));
  const lines = [`Self-improvement work finder: ${mode} (MARINA_SELF_IMPROVE)`];
  if (live.length) {
    lines.push("Recurring in the last 24 h, not yet filed:");
    for (const s of live.slice(0, 10))
      lines.push(`  ${s.count}× ${s.level} [${s.category}] ${s.template}`);
  } else lines.push("Nothing recurring past the threshold in the last 24 h.");
  const filed = Object.values(state.filed);
  if (filed.length) {
    lines.push("Filed:");
    for (const id of filed.slice(-10)) {
      const task = db.getTask(id);
      lines.push(`  task ${id}${task ? ` [${task.status}] ${task.title}` : " (gone)"}`);
    }
  }
  if (mode === "observe" && live.length)
    lines.push("Set MARINA_SELF_IMPROVE=on to file these as fix tasks (at most 3 a day).");
  sendCode(ctx, eid, lines.join("\n"), { event: "code_improve", type: "session" });
}
