// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { residentInstructions } from "../scripts/supervise";

describe("supervised resident instructions", () => {
  const text = residentInstructions();

  it("teach world commands as plain relay calls", () => {
    expect(text).toContain('connect -c "<command>"');
    expect(text).toContain("Run each one as its own plain command");
    for (const construct of ["$(…)", "$?", "pipes", "loops", "&& or ; chains"])
      expect(text).toContain(construct);
    expect(text).toContain("no double quotes inside the message");
  });

  it("never model a shell expansion in an example command", () => {
    const examples = text.slice(text.indexOf("Useful commands:"));
    expect(examples).not.toMatch(/\$\(|\$\?|\||&&|;\s*marina/);
  });

  it("name the reply verbs a resident answers owed tells with", () => {
    expect(text).toContain("re #<id> <message>");
    expect(text).toContain("tell inbox");
  });
});
