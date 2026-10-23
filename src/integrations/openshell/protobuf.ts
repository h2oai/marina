// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The few protobuf wire rules the OpenShell client needs, with no dependency:
 * varints, length-delimited fields (strings, bytes, nested messages, map
 * entries), and a decoder that returns fields by number. Only proto3 scalar
 * kinds that OpenShell's messages use here are supported.
 */

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

/** A message under construction: append fields, then `bytes()`. */
export class ProtoWriter {
  private readonly parts: Uint8Array[] = [];

  private push(bytes: number[] | Uint8Array): void {
    this.parts.push(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
  }

  private tag(field: number, wire: number): void {
    this.push(varint(BigInt((field << 3) | wire)));
  }

  /** A varint field (uint32, int32, bool, enum). Zero is the default and is omitted. */
  uint(field: number, value: number | bigint | boolean | undefined): this {
    if (value === undefined || value === false || value === 0 || value === 0n) return this;
    const n = typeof value === "boolean" ? 1n : BigInt(value);
    this.tag(field, WIRE_VARINT);
    // A negative int32 is sign-extended to 64 bits on the wire.
    this.push(varint(n < 0n ? n + (1n << 64n) : n));
    return this;
  }

  string(field: number, value: string | undefined): this {
    if (!value) return this;
    return this.bytesField(field, new TextEncoder().encode(value));
  }

  bytesField(field: number, value: Uint8Array | undefined): this {
    if (!value || value.length === 0) return this;
    this.tag(field, WIRE_LEN);
    this.push(varint(BigInt(value.length)));
    this.push(value);
    return this;
  }

  /** A nested message; written even when empty (a set oneof member must be present). */
  message(field: number, value: ProtoWriter | undefined): this {
    if (!value) return this;
    const inner = value.bytes();
    this.tag(field, WIRE_LEN);
    this.push(varint(BigInt(inner.length)));
    this.push(inner);
    return this;
  }

  repeatedString(field: number, values: readonly string[] | undefined): this {
    for (const value of values ?? []) {
      const encoded = new TextEncoder().encode(value);
      this.tag(field, WIRE_LEN);
      this.push(varint(BigInt(encoded.length)));
      this.push(encoded);
    }
    return this;
  }

  /** `map<string, string>`: one entry message (key = 1, value = 2) per pair. */
  stringMap(field: number, values: Record<string, string> | undefined): this {
    for (const [key, value] of Object.entries(values ?? {}))
      this.message(field, new ProtoWriter().string(1, key).string(2, value));
    return this;
  }

  bytes(): Uint8Array {
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

function varint(value: bigint): number[] {
  const out: number[] = [];
  let n = value;
  while (n > 127n) {
    out.push(Number(n & 127n) | 128);
    n >>= 7n;
  }
  out.push(Number(n));
  return out;
}

/** A decoded field value: a varint (as bigint), fixed-width bits, or raw bytes. */
export type ProtoValue = bigint | Uint8Array;

/** A decoded message: every occurrence of each field number, in order. */
export class ProtoMessage {
  private constructor(private readonly fields: Map<number, ProtoValue[]>) {}

  static decode(bytes: Uint8Array): ProtoMessage {
    const fields = new Map<number, ProtoValue[]>();
    let at = 0;
    const readVarint = (): bigint => {
      let result = 0n;
      let shift = 0n;
      for (;;) {
        if (at >= bytes.length) throw new Error("Truncated protobuf varint");
        const byte = bytes[at++]!;
        result |= BigInt(byte & 127) << shift;
        if (byte < 128) return result;
        shift += 7n;
        if (shift > 70n) throw new Error("Malformed protobuf varint");
      }
    };
    while (at < bytes.length) {
      const key = readVarint();
      const field = Number(key >> 3n);
      const wire = Number(key & 7n);
      let value: ProtoValue;
      if (wire === WIRE_VARINT) value = readVarint();
      else if (wire === WIRE_LEN) {
        const length = Number(readVarint());
        if (at + length > bytes.length) throw new Error("Truncated protobuf field");
        value = bytes.subarray(at, at + length);
        at += length;
      } else if (wire === WIRE_I64 || wire === WIRE_I32) {
        const width = wire === WIRE_I64 ? 8 : 4;
        if (at + width > bytes.length) throw new Error("Truncated protobuf field");
        value = bytes.subarray(at, at + width);
        at += width;
      } else throw new Error(`Unsupported protobuf wire type ${wire}`);
      const list = fields.get(field);
      if (list) list.push(value);
      else fields.set(field, [value]);
    }
    return new ProtoMessage(fields);
  }

  has(field: number): boolean {
    return this.fields.has(field);
  }

  private last(field: number): ProtoValue | undefined {
    const list = this.fields.get(field);
    return list?.[list.length - 1];
  }

  /** An unsigned varint field (enum, uint32, bool), 0 when absent. */
  uint(field: number): number {
    const v = this.last(field);
    return typeof v === "bigint" ? Number(BigInt.asUintN(32, v)) : 0;
  }

  /** A signed int32 field, 0 when absent. */
  int32(field: number): number {
    const v = this.last(field);
    return typeof v === "bigint" ? Number(BigInt.asIntN(32, v)) : 0;
  }

  string(field: number): string {
    const v = this.last(field);
    return v instanceof Uint8Array ? new TextDecoder().decode(v) : "";
  }

  bytes(field: number): Uint8Array {
    const v = this.last(field);
    return v instanceof Uint8Array ? v : new Uint8Array();
  }

  message(field: number): ProtoMessage | undefined {
    const v = this.last(field);
    return v instanceof Uint8Array ? ProtoMessage.decode(v) : undefined;
  }

  messages(field: number): ProtoMessage[] {
    return (this.fields.get(field) ?? [])
      .filter((v): v is Uint8Array => v instanceof Uint8Array)
      .map((v) => ProtoMessage.decode(v));
  }

  /** `map<string, string>` entries. */
  stringMap(field: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of this.messages(field)) out[entry.string(1)] = entry.string(2);
    return out;
  }
}
