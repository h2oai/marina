// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { entity as fmtEntity, rank as fmtRank, success } from "../../net/ansi";
import type { MarinaDB } from "../../persistence/database";
import type { CommandDef, Entity, EntityRank, RoomContext } from "../../types";
import { getRank, setRank } from "../permissions";
import { grantGatesForRank } from "../safety-gates";

interface RankDeps {
  findEntity: (name: string) => Entity | undefined;
  db?: MarinaDB;
}

export function rankCommand(deps: RankDeps): CommandDef {
  return {
    name: "rank",
    aliases: [],
    help: "Check your rank or set another entity's rank. Usage: rank [entity [level]]",
    handler: (ctx: RoomContext, input) => {
      const self = ctx.getEntity(input.entity);
      if (!self) return;

      if (!input.args) {
        const r = getRank(self);
        ctx.send(input.entity, `Your rank: ${fmtRank(r)}`);
        return;
      }

      const tokens = input.tokens;
      const targetName = tokens[0];
      if (!targetName) {
        ctx.send(input.entity, "Usage: rank [entity [level]]");
        return;
      }

      if (tokens.length < 2) {
        // Check another player's rank
        const target = deps.findEntity(targetName);
        if (!target) {
          ctx.send(input.entity, `Entity "${targetName}" not found.`);
          return;
        }
        const r = getRank(target);
        ctx.send(input.entity, `${fmtEntity(target.name)}'s rank: ${fmtRank(r)}`);
        return;
      }

      // Set rank: requires sovereign (9)
      if (getRank(self) < 9) {
        ctx.send(input.entity, "Only sovereigns (rank 9) can set ranks.");
        return;
      }

      const target = deps.findEntity(targetName);
      if (!target) {
        ctx.send(input.entity, `Entity "${targetName}" not found.`);
        return;
      }

      const level = Number.parseInt(tokens[1] ?? "", 10);
      if (Number.isNaN(level) || level < 0 || level > 9) {
        ctx.send(
          input.entity,
          "Rank must be 0-9 (newcomer, canvas, coordinator, organizer, builder, architect, engineer, steward, guardian, sovereign).",
        );
        return;
      }

      setRank(target, level as EntityRank);

      // Persist to database; grant safety-gate set when promoting past
      // the safety threshold (rank ≥ 5). Below 5 the tiers are descriptive
      // only and don't unlock any gates.
      if (deps.db) {
        const user = deps.db.getUserByName(target.name);
        if (user) deps.db.updateUserRank(user.id, level);
        if (level >= 5) grantGatesForRank(deps.db, target.id, level);
      }

      ctx.send(
        input.entity,
        success(`Set ${fmtEntity(target.name)}'s rank to ${fmtRank(level as EntityRank)}.`),
      );
      ctx.send(target.id, success(`Your rank has been set to ${fmtRank(level as EntityRank)}.`));
    },
  };
}
