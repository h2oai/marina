// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { commandForms, composeCommand } from "../dashboard/src/lib/command-forms";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb } from "./helpers";

describe("dashboard command form coverage", () => {
  it("provides constructible parameter forms for every registered command", () => {
    const path = `/tmp/marina-command-forms-${process.pid}.db`;
    const db = new MarinaDB(path);
    try {
      const engine = new Engine({ startRoom: roomId("test/forms"), db });
      const catalog = engine.commands.allBuiltins();
      expect(catalog.length).toBeGreaterThan(100);
      for (const command of catalog) {
        const forms = commandForms(command);
        expect(forms.length, command.name).toBeGreaterThan(0);
        for (const form of forms) {
          const values = Object.fromEntries(
            form.fields.map((field) => [
              field.id,
              field.kind === "json" || field.kind === "number"
                ? "1"
                : field.kind === "choice"
                  ? (field.choices?.find(Boolean) ?? "sample")
                  : "sample",
            ]),
          );
          const enabled = Object.fromEntries(form.groups.map((group) => [group.id, true]));
          const result = composeCommand(form, values, enabled);
          expect(result.errors, form.syntax).toEqual({});
          expect(result.command.startsWith(command.name), form.syntax).toBe(true);
          expect(result.command).not.toContain("[object Object]");
        }
      }
    } finally {
      db.close();
      cleanupDb(path);
    }
  });
});
