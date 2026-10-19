// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { classifyCommandRisk, commandParts } from "../src/agent/tool-policy";
import { describeCommand } from "../src/engine/command-manifest";
import { commandFormPrefix } from "../src/sdk/command-forms";
import type { CommandInput, EntityId, RoomId } from "../src/types";
import { createTestEngine } from "./engine-fixture";

// The agent-side risk allowlist against the effects commands declare on their
// usage forms: the allowlist may be more cautious than a declaration, never less.
describe("tool risk vs declared command effects", () => {
  it("never reads a form a command declares as a write, delete or execution", async () => {
    const t = createTestEngine();
    try {
      let checked = 0;
      for (const def of t.engine.commands.allBuiltins()) {
        for (const form of describeCommand(def).forms ?? []) {
          if (form.effect !== "write" && form.effect !== "delete" && form.effect !== "execute") {
            continue;
          }
          // Placeholder words that are no command or alias (`x` is `examine`), so a
          // `batch` form is judged by an unknown command, as an unknown batch is.
          const command = `${commandFormPrefix(form)} arg1 arg2`;
          const risk = classifyCommandRisk(command);
          const lax = risk === "read" || risk === "self" || risk === "egress";
          expect([command, lax]).toEqual([command, false]);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    } finally {
      await t.dispose();
    }
  });

  it("every builtin command form declares its effect", async () => {
    const t = createTestEngine();
    try {
      const undeclared: string[] = [];
      let forms = 0;
      for (const def of t.engine.commands.allBuiltins()) {
        // A command with no forms publishes no effect at all; require forms too.
        if (!def.usage?.length) undeclared.push(`${def.name} (no usage forms)`);
        for (const form of describeCommand(def).forms ?? []) {
          forms++;
          if (!form.effect || form.effect === "unknown") undeclared.push(form.syntax);
        }
      }
      // Declare `{ syntax, effect: "read" | "write" | "delete" | "execute" }` on
      // every usage form. `read` is advertised to MCP clients as readOnlyHint,
      // so use it only for forms that change nothing.
      expect(undeclared).toEqual([]);
      expect(forms).toBeGreaterThan(1000);
    } finally {
      await t.dispose();
    }
  });

  it("labels every form the router treats as read-only as a read", async () => {
    const t = createTestEngine();
    try {
      let checked = 0;
      for (const def of t.engine.commands.allBuiltins()) {
        if (!def.readOnlyForm) continue;
        for (const form of describeCommand(def).forms ?? []) {
          const raw = commandFormPrefix(form);
          const [verb = "", ...tokens] = raw.split(" ");
          const input: CommandInput = {
            raw,
            verb,
            args: tokens.join(" "),
            tokens,
            entity: "e_1" as EntityId,
            room: "test/room" as RoomId,
          };
          if (!def.readOnlyForm(input)) continue;
          expect([form.syntax, form.effect]).toEqual([form.syntax, "read"]);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    } finally {
      await t.dispose();
    }
  });

  it("splits a command string exactly where the router does", async () => {
    const t = createTestEngine();
    try {
      const { entityId } = t.login("Ada");
      const ran: string[] = [];
      t.engine.commands.registerBuiltin({
        name: "probecmd",
        help: "probe",
        handler: () => {
          ran.push("probecmd");
        },
      });
      const run = async (command: string) => {
        t.db.setCoreMemory("Ada", "rest", "waiting");
        ran.length = 0;
        expect(commandParts(command).length).toBeGreaterThan(0);
        await t.engine.dispatchCommand(entityId, command);
        await t.engine.drainCommands();
        return { ran: [...ran], rest: t.db.getCoreMemory("Ada", "rest")?.value };
      };
      // A plain command is ONE command: `probecmd` never runs, `rest` is untouched.
      const plain = "memory delete rest; probecmd";
      expect(commandParts(plain)).toEqual([plain]);
      expect(await run(plain)).toEqual({ ran: [], rest: "waiting" });
      // A batch runs each part.
      const batch = "batch memory delete rest; probecmd";
      expect(commandParts(batch)).toEqual(["memory delete rest", "probecmd"]);
      expect(await run(batch)).toEqual({ ran: ["probecmd"], rest: undefined });
    } finally {
      await t.dispose();
    }
  });
});
