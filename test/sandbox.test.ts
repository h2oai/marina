import { describe, expect, it } from "bun:test";
import {
  compileRoomModule,
  DEFAULT_ROOM_SOURCE,
  SandboxError,
  validateRoomSource,
} from "../src/engine/sandbox";

describe("Sandbox - validateRoomSource", () => {
  it("accepts valid room source", () => {
    const result = validateRoomSource(DEFAULT_ROOM_SOURCE);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects source with process access", () => {
    const source = `
      export default { short: "Test", long: "Test room" };
      process.exit(1);
    `;
    const result = validateRoomSource(source);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("process"))).toBe(true);
  });

  it("rejects source with require()", () => {
    const source = `
      const fs = require("fs");
      export default { short: "Test", long: "Test room" };
    `;
    const result = validateRoomSource(source);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("require"))).toBe(true);
  });

  it("rejects source with dynamic import()", () => {
    const source = `
      const mod = import("child_process");
      export default { short: "Test", long: "Test room" };
    `;
    const result = validateRoomSource(source);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("import"))).toBe(true);
  });

  it("rejects source with eval()", () => {
    const source = `
      eval("alert(1)");
      export default { short: "Test", long: "Test room" };
    `;
    const result = validateRoomSource(source);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("eval"))).toBe(true);
  });

  it("rejects source with fetch()", () => {
    const source = `
      fetch("http://evil.com");
      export default { short: "Test", long: "Test room" };
    `;
    const result = validateRoomSource(source);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fetch"))).toBe(true);
  });

  it("rejects source with Bun access", () => {
    const source = `
      Bun.write("/tmp/hack", "data");
      export default { short: "Test", long: "Test room" };
    `;
    const result = validateRoomSource(source);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Bun"))).toBe(true);
  });

  it("rejects source without default export", () => {
    const source = `
      const room = { short: "Test", long: "Test room" };
    `;
    const result = validateRoomSource(source);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("default export"))).toBe(true);
  });

  it("ignores forbidden patterns inside string literals", () => {
    const source = `
      export default {
        short: "Test",
        long: "The process of creation is what matters here.",
      };
    `;
    const result = validateRoomSource(source);
    expect(result.valid).toBe(true);
  });

  it("ignores forbidden patterns inside comments", () => {
    const source = `
      // process.exit() would be bad
      /* eval("evil") */
      export default { short: "Test", long: "Test room" };
    `;
    const result = validateRoomSource(source);
    expect(result.valid).toBe(true);
  });

  it("can detect multiple violations at once", () => {
    const source = `
      process.exit(1);
      eval("alert(1)");
      fetch("http://evil.com");
      export default { short: "Test", long: "Test room" };
    `;
    const result = validateRoomSource(source);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("Sandbox - compileRoomModule", () => {
  it("compiles valid TypeScript room source", async () => {
    const source = `
      export default {
        short: "Compiled Room",
        long: "A room compiled from source.",
        exits: {},
      };
    `;
    const module = await compileRoomModule(source);
    expect(module.short).toBe("Compiled Room");
    expect(module.long).toBe("A room compiled from source.");
    expect(module.exits).toEqual({});
  });

  it("compiles room with items", async () => {
    const source = `
      export default {
        short: "Item Room",
        long: "A room with items.",
        items: {
          "table": "A sturdy wooden table.",
          "chair": "A comfortable chair.",
        },
      };
    `;
    const module = await compileRoomModule(source);
    expect(module.items).toBeDefined();
    expect(Object.keys(module.items!)).toHaveLength(2);
  });

  it("rejects source that fails validation", async () => {
    const source = `
      process.exit(1);
      export default { short: "Bad", long: "Bad room" };
    `;
    await expect(compileRoomModule(source)).rejects.toThrow(SandboxError);
  });

  it("rejects compiled module missing short", async () => {
    const source = `
      export default { long: "No short description" };
    `;
    await expect(compileRoomModule(source)).rejects.toThrow(SandboxError);
  });

  it("rejects compiled module missing long", async () => {
    const source = `
      export default { short: "Has short" };
    `;
    await expect(compileRoomModule(source)).rejects.toThrow(SandboxError);
  });

  it("compiles the default room template", async () => {
    const module = await compileRoomModule(DEFAULT_ROOM_SOURCE);
    expect(module.short).toBe("An empty room");
    expect(module.exits).toEqual({});
  });
});
