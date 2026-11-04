// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * ONNX Runtime 1.29+ ships a telemetry uploader (1DS) that is on by default on
 * Linux and macOS. Its documented switch is `ORT_DISABLE_TELEMETRY=1` in the
 * process environment BEFORE the runtime initializes (microsoft/onnxruntime
 * docs/Privacy.md: it prevents the uploader, the events and the persistent
 * device identifier for the process lifetime).
 *
 * Bun's `process.env` assignments do not reach the native environment that
 * the runtime reads with getenv, so the variable is written through the C
 * library (or the Windows API) here, before `import("onnxruntime-node")`.
 * An operator who set the variable themselves is left alone. If the switch
 * cannot be written, loading stops: the runtime never starts with telemetry on.
 */

import { CString, dlopen, FFIType, ptr } from "bun:ffi";

export const ORT_TELEMETRY_VARIABLE = "ORT_DISABLE_TELEMETRY";

/** What `disableOnnxTelemetry` found or did. */
export type TelemetrySwitch = "set" | "already-set";

interface NativeEnvironment {
  get(name: string): string | undefined;
  set(name: string, value: string): boolean;
}

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf8");
}

function wideString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}

function posixEnvironment(): NativeEnvironment {
  const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    getenv: { args: [FFIType.ptr], returns: FFIType.ptr },
    setenv: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  return {
    get(name) {
      const value = libc.symbols.getenv(ptr(cString(name)));
      return value ? new CString(value).toString() : undefined;
    },
    set(name, value) {
      return libc.symbols.setenv(ptr(cString(name)), ptr(cString(value)), 1) === 0;
    },
  };
}

function windowsEnvironment(): NativeEnvironment {
  const kernel32 = dlopen("kernel32.dll", {
    GetEnvironmentVariableW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
      returns: FFIType.u32,
    },
    SetEnvironmentVariableW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  return {
    get(name) {
      const buffer = Buffer.alloc(64 * 2);
      const length = kernel32.symbols.GetEnvironmentVariableW(
        ptr(wideString(name)),
        ptr(buffer),
        64,
      );
      return length > 0 && length < 64 ? buffer.toString("utf16le", 0, length * 2) : undefined;
    },
    set(name, value) {
      return (
        kernel32.symbols.SetEnvironmentVariableW(ptr(wideString(name)), ptr(wideString(value))) !==
        0
      );
    },
  };
}

/** The process's native environment (the one native libraries read). */
export function nativeEnvironment(): NativeEnvironment {
  return process.platform === "win32" ? windowsEnvironment() : posixEnvironment();
}

/**
 * Turn ONNX Runtime's telemetry off for this process before the runtime loads.
 * Throws when the switch cannot be written, so the caller never loads the
 * runtime with telemetry on.
 */
export function disableOnnxTelemetry(
  env: NativeEnvironment = nativeEnvironment(),
): TelemetrySwitch {
  if (env.get(ORT_TELEMETRY_VARIABLE)?.trim()) return "already-set";
  if (!env.set(ORT_TELEMETRY_VARIABLE, "1") || env.get(ORT_TELEMETRY_VARIABLE) !== "1") {
    throw new Error(
      `Local embeddings refused to start: ${ORT_TELEMETRY_VARIABLE}=1 could not be set in the process environment, so ONNX Runtime's telemetry could not be turned off. Set ${ORT_TELEMETRY_VARIABLE}=1 before starting Marina.`,
    );
  }
  process.env[ORT_TELEMETRY_VARIABLE] = "1";
  return "set";
}
