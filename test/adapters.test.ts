// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Adapter, Medium } from "../src/net/adapter";
import { formatPerception } from "../src/net/formatter";
import { MarinaDB } from "../src/persistence/database";
import type { Perception, RoomId } from "../src/types";
import { cleanupDb } from "./helpers";

describe("Adapter Interface", () => {
  it("should define correct adapter shape", () => {
    const adapter: Adapter = {
      name: "test",
      protocol: "test",
      start: () => {},
      stop: () => {},
    };
    expect(adapter.name).toBe("test");
    expect(adapter.protocol).toBe("test");
  });
});

describe("Adapter Link DB", () => {
  let db: MarinaDB;
  const dbPath = `/tmp/marina-adapter-db-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should link telegram chat to user", () => {
    db.linkAdapter("telegram", "12345", "u_1");
    const link = db.getLinkedUser("telegram", "12345");
    expect(link).toBeDefined();
    expect(link!.user_id).toBe("u_1");
    expect(link!.adapter).toBe("telegram");
  });

  it("should link discord user to user", () => {
    db.linkAdapter("discord", "disc_999", "u_2");
    const link = db.getLinkedUser("discord", "disc_999");
    expect(link).toBeDefined();
    expect(link!.user_id).toBe("u_2");
  });

  it("should support multiple adapters per user", () => {
    db.linkAdapter("telegram", "tg_1", "u_1");
    db.linkAdapter("discord", "dc_1", "u_1");
    const links = db.getUserLinks("u_1");
    expect(links.length).toBe(2);
  });

  it("should unlink adapter", () => {
    db.linkAdapter("telegram", "tg_1", "u_1");
    expect(db.unlinkAdapter("telegram", "tg_1")).toBe(true);
    expect(db.getLinkedUser("telegram", "tg_1")).toBeUndefined();
  });

  it("should replace existing link on same adapter+external_id", () => {
    db.linkAdapter("telegram", "tg_1", "u_1");
    db.linkAdapter("telegram", "tg_1", "u_2"); // re-link to different user
    const link = db.getLinkedUser("telegram", "tg_1");
    expect(link!.user_id).toBe("u_2");
  });
});

// ─── Adapter User Mappings (Persistence for Discord/Telegram) ───────────────

describe("Adapter User Mappings", () => {
  let db: MarinaDB;
  const dbPath = `/tmp/marina-adapter-mappings-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should save and retrieve a Discord user mapping", () => {
    db.saveAdapterUserMapping("discord", "123456789", "AliceBot");
    const mapping = db.getAdapterUserMapping("discord", "123456789");
    expect(mapping).toBeDefined();
    expect(mapping!.platform).toBe("discord");
    expect(mapping!.platform_user_id).toBe("123456789");
    expect(mapping!.entity_name).toBe("AliceBot");
    expect(mapping!.created_at).toBeGreaterThan(0);
  });

  it("should save and retrieve a Telegram user mapping", () => {
    db.saveAdapterUserMapping("telegram", "987654321", "BobBot");
    const mapping = db.getAdapterUserMapping("telegram", "987654321");
    expect(mapping).toBeDefined();
    expect(mapping!.platform).toBe("telegram");
    expect(mapping!.platform_user_id).toBe("987654321");
    expect(mapping!.entity_name).toBe("BobBot");
  });

  it("should replace existing mapping on same platform+user", () => {
    db.saveAdapterUserMapping("discord", "111", "OldName");
    db.saveAdapterUserMapping("discord", "111", "NewName");
    const mapping = db.getAdapterUserMapping("discord", "111");
    expect(mapping!.entity_name).toBe("NewName");
  });

  it("should list all mappings for a platform", () => {
    db.saveAdapterUserMapping("discord", "aaa", "Entity1");
    db.saveAdapterUserMapping("discord", "bbb", "Entity2");
    db.saveAdapterUserMapping("telegram", "ccc", "Entity3");

    const discordMappings = db.getAdapterUserMappings("discord");
    expect(discordMappings.length).toBe(2);

    const telegramMappings = db.getAdapterUserMappings("telegram");
    expect(telegramMappings.length).toBe(1);
    expect(telegramMappings[0]!.entity_name).toBe("Entity3");
  });

  it("should delete a specific mapping", () => {
    db.saveAdapterUserMapping("discord", "del1", "ToDelete");
    expect(db.deleteAdapterUserMapping("discord", "del1")).toBe(true);
    expect(db.getAdapterUserMapping("discord", "del1")).toBeUndefined();
  });

  it("should return false when deleting non-existent mapping", () => {
    expect(db.deleteAdapterUserMapping("discord", "nonexistent")).toBe(false);
  });

  it("should keep platform namespaces separate", () => {
    db.saveAdapterUserMapping("discord", "shared_id", "DiscordEntity");
    db.saveAdapterUserMapping("telegram", "shared_id", "TelegramEntity");

    const discord = db.getAdapterUserMapping("discord", "shared_id");
    const telegram = db.getAdapterUserMapping("telegram", "shared_id");

    expect(discord!.entity_name).toBe("DiscordEntity");
    expect(telegram!.entity_name).toBe("TelegramEntity");
  });

  it("should return undefined for non-existent mapping", () => {
    const mapping = db.getAdapterUserMapping("discord", "nobody");
    expect(mapping).toBeUndefined();
  });

  it("should return empty array for platform with no mappings", () => {
    const mappings = db.getAdapterUserMappings("discord");
    expect(mappings).toEqual([]);
  });

  it("should persist mappings across DB reconnection", () => {
    db.saveAdapterUserMapping("discord", "persist1", "PersistBot");
    db.close();

    // Reopen the database
    const db2 = new MarinaDB(dbPath);
    const mapping = db2.getAdapterUserMapping("discord", "persist1");
    expect(mapping).toBeDefined();
    expect(mapping!.entity_name).toBe("PersistBot");
    db2.close();
  });
});

describe("Formatter for adapter mediums", () => {
  const roomP: Perception = {
    kind: "room",
    timestamp: Date.now(),
    data: {
      id: "test/room" as RoomId,
      short: "Hub",
      long: "Central hub.",
      items: { fountain: "A sparkling fountain." },
      exits: ["north"],
      entities: [],
    },
  };

  const mediums: Medium[] = ["json", "ansi", "markdown", "plaintext", "html"];

  for (const medium of mediums) {
    it(`should format room perception for ${medium}`, () => {
      const result = formatPerception(roomP, medium);
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);
      // All mediums should contain the room short description somewhere
      expect(result).toContain("Hub");
    });
  }

  it("should format different perception kinds", () => {
    const kinds = ["message", "error", "system", "broadcast"] as const;
    for (const kind of kinds) {
      const p: Perception = {
        kind,
        timestamp: Date.now(),
        data: { text: `Test ${kind}` },
      };
      for (const medium of mediums) {
        const result = formatPerception(p, medium);
        expect(result).toContain(`Test ${kind}`);
      }
    }
  });
});
