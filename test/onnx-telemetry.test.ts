// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local embeddings turn ONNX Runtime's telemetry off before the runtime loads
 * (extensions/local-embeddings/telemetry.ts): the switch is written to the
 * NATIVE environment, an operator's own value is kept, and a switch that
 * cannot be written stops the load.
 */

import { describe, expect, it } from "bun:test";
import {
  disableOnnxTelemetry,
  nativeEnvironment,
  ORT_TELEMETRY_VARIABLE,
} from "../extensions/local-embeddings/telemetry";

function fakeEnvironment(initial: Record<string, string> = {}, writable = true) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: (name: string) => values.get(name),
    set: (name: string, value: string) => {
      if (writable) values.set(name, value);
      return writable;
    },
  };
}

describe("ONNX Runtime telemetry switch", () => {
  it("sets ORT_DISABLE_TELEMETRY=1 when the operator set nothing", () => {
    const env = fakeEnvironment();
    expect(disableOnnxTelemetry(env)).toBe("set");
    expect(env.values.get(ORT_TELEMETRY_VARIABLE)).toBe("1");
  });

  it("keeps an operator's own value", () => {
    const env = fakeEnvironment({ [ORT_TELEMETRY_VARIABLE]: "true" });
    expect(disableOnnxTelemetry(env)).toBe("already-set");
    expect(env.values.get(ORT_TELEMETRY_VARIABLE)).toBe("true");
  });

  it("refuses to continue when the switch cannot be written", () => {
    expect(() => disableOnnxTelemetry(fakeEnvironment({}, false))).toThrow(/refused to start/);
  });

  it("writes the real native environment, which process.env alone does not reach", () => {
    const native = nativeEnvironment();
    const before = native.get(ORT_TELEMETRY_VARIABLE);
    disableOnnxTelemetry(native);
    expect(native.get(ORT_TELEMETRY_VARIABLE)).toBe(before?.trim() ? before : "1");
  });
});
