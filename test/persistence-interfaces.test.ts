// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import type { MarinaStores, SettingsStore } from "../src/persistence/interfaces";
import { STORE_METHOD_MANIFEST } from "../src/persistence/interfaces";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_persistence_interfaces.db";

/**
 * Facade members that are deliberately NOT part of any store interface: the
 * constructor and the two private migration helpers. Everything else on the
 * prototype must be claimed by exactly one interface, so an interface cannot
 * silently drift away from the facade (or vice versa).
 */
const FACADE_ONLY = new Set(["constructor", "runMigrations", "getSchemaVersion"]);

/** Compile-time: an instance of the facade is assignable to the aggregate store type. */
function acceptStores(stores: MarinaStores): MarinaStores {
  return stores;
}

/**
 * A plain Map-backed fake of one store. Its existence proves a slice can be
 * implemented without the class (the interfaces are explicit, not `Pick`s of
 * `MarinaDB`), which is what lets a consumer later type a constructor
 * parameter as `SettingsStore` and be handed this in a test.
 */
function mapSettingsStore(defaultModel = "marina/default"): SettingsStore {
  const settings = new Map<string, string>();
  const meta = new Map<string, string>();
  return {
    getMetaValue: (key) => meta.get(key),
    setMetaValue: (key, value) => {
      meta.set(key, value);
    },
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => {
      settings.set(key, value);
    },
    deleteSetting: (key) => {
      settings.delete(key);
    },
    listSettingsByPrefix: (prefix) =>
      [...settings.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    getDefaultModel: () => settings.get("default_model") ?? defaultModel,
  };
}

describe("persistence store interfaces", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("MarinaDB satisfies the aggregate MarinaStores type", () => {
    // `MarinaDB implements MarinaStores` is enforced by tsc; this pins the
    // structural direction too (an instance flows where the interfaces are asked for).
    expect(acceptStores(db)).toBe(db);
    const notes: Pick<MarinaStores, "createNote" | "getNote"> = db;
    const id = notes.createNote("alice", "interfaces are structural");
    expect(notes.getNote(id)?.content).toBe("interfaces are structural");
  });

  it("every public facade method is claimed by exactly one store interface", () => {
    const facade = Object.getOwnPropertyNames(MarinaDB.prototype)
      .filter((name) => !FACADE_ONLY.has(name))
      .sort();

    const claimedBy = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [store, methods] of Object.entries(STORE_METHOD_MANIFEST)) {
      for (const method of methods) {
        const prior = claimedBy.get(method);
        if (prior) duplicates.push(`${method} (${prior} and ${store})`);
        claimedBy.set(method, store);
      }
    }
    expect(duplicates).toEqual([]);

    const manifest = [...claimedBy.keys()].sort();
    const unclaimed = facade.filter((name) => !claimedBy.has(name));
    const phantom = manifest.filter((name) => !facade.includes(name));
    expect({ unclaimed, phantom }).toEqual({ unclaimed: [], phantom: [] });
    expect(manifest).toEqual(facade);
  });

  it("every manifest entry is a function on the facade", () => {
    for (const methods of Object.values(STORE_METHOD_MANIFEST)) {
      for (const method of methods) {
        expect(typeof (db as unknown as Record<string, unknown>)[method]).toBe("function");
      }
    }
  });

  it("a store interface can be implemented by a plain object (Map-backed fake)", () => {
    const fake = mapSettingsStore();
    fake.setSetting("passthru.inject", "on");
    fake.setSetting("passthru.budget", "2048");
    fake.setMetaValue("schema_note", "fake");

    expect(fake.getSetting("passthru.inject")).toBe("on");
    expect(
      fake
        .listSettingsByPrefix("passthru.")
        .map((row) => row.key)
        .sort(),
    ).toEqual(["passthru.budget", "passthru.inject"]);
    expect(fake.getDefaultModel()).toBe("marina/default");
    fake.setSetting("default_model", "anthropic/claude");
    expect(fake.getDefaultModel()).toBe("anthropic/claude");
    fake.deleteSetting("default_model");
    expect(fake.getSetting("default_model")).toBeUndefined();
    expect(fake.getMetaValue("schema_note")).toBe("fake");

    // The real facade and the fake are interchangeable behind the slice.
    const behaviours: SettingsStore[] = [fake, db];
    for (const store of behaviours) {
      store.setSetting("probe", "1");
      expect(store.getSetting("probe")).toBe("1");
      expect(store.listSettingsByPrefix("pro").some((row) => row.key === "probe")).toBe(true);
    }
  });
});
