// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural parity between the backend `/api/entity/:name/profile` contract
 * (`src/net/entity-profile-types.ts`, re-exported by `src/net/entity-api.ts`)
 * and the two dashboard modules that consume it (`lib/entity-profile-types`
 * and `who/types`). Both re-export the wire types, so what is pinned here is
 * that the re-export chain stays intact and that the dashboard-only derived
 * aliases keep following the contract — the places a future "let me just
 * inline this" edit would silently fork it again.
 *
 * `expectTypeOf` assertions are type-level: they fail `tsc --noEmit`
 * (`bunx tsc --noEmit` in dashboard/, run by CI), not the vitest run. The
 * runtime `expect`s cover the value-level constants.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type * as Backend from "../../../src/net/entity-profile-types";
import type * as Lib from "../lib/entity-profile-types";
import * as Who from "../who/types";

describe("entity-profile-types (dashboard lib) matches the backend contract", () => {
  it("re-exports every wire type unchanged", () => {
    expectTypeOf<Lib.EntityProfile>().toEqualTypeOf<Backend.EntityProfile>();
    expectTypeOf<Lib.Achievement>().toEqualTypeOf<Backend.Achievement>();
    expectTypeOf<Lib.ChronicleEntry>().toEqualTypeOf<Backend.ChronicleEntry>();
    expectTypeOf<Lib.ChronicleKind>().toEqualTypeOf<Backend.ChronicleKind>();
  });

  it("is mutually assignable (a server payload is a dashboard profile and vice versa)", () => {
    expectTypeOf<Backend.EntityProfile>().toMatchTypeOf<Lib.EntityProfile>();
    expectTypeOf<Lib.EntityProfile>().toMatchTypeOf<Backend.EntityProfile>();
  });
});

describe("who/types matches the backend contract", () => {
  it("re-exports the wire types and derives its aliases from them", () => {
    expectTypeOf<Who.EntityProfile>().toEqualTypeOf<Backend.EntityProfile>();
    expectTypeOf<Who.Achievement>().toEqualTypeOf<Backend.Achievement>();
    expectTypeOf<Who.ChronicleEntry>().toEqualTypeOf<Backend.ChronicleEntry>();
    expectTypeOf<Who.ChronicleKind>().toEqualTypeOf<Backend.ChronicleKind>();
    expectTypeOf<Who.EntityIdentity>().toEqualTypeOf<Backend.EntityProfile["identity"]>();
    expectTypeOf<Who.EntityConnection>().toEqualTypeOf<
      Backend.EntityProfile["connections"][number]
    >();
    // The literal members the page switches on must still be present.
    expectTypeOf<
      "event" | "narrative" | "digest" | "correction"
    >().toEqualTypeOf<Who.ChronicleKind>();
    expectTypeOf<
      "verified_human" | "internal_agent" | "session_only" | "record_only"
    >().toEqualTypeOf<Who.EntityIdentity["identity_assurance"]>();
  });

  it("a complete server payload satisfies both sides at the value level", () => {
    const payload = {
      identity: {
        local_id: "e_1",
        id_stability: "durable",
        name: "Alice",
        kind: "agent",
        role: "guide",
        rank: 2,
        standing: 17.5,
        first_seen: 1,
        last_active: 2,
        online: true,
        spawned_by: null,
        identity_assurance: "internal_agent",
      },
      bio: { goal: null, model: "marina/default", traits: ["curious"], operator_bio: null },
      narratives: [
        {
          id: 1,
          created_at: 3,
          kind: "narrative",
          source: "chronicler",
          title: "First light",
          body: "…",
          participants: ["Alice"],
          refs: ["chronicle:0"],
          period: null,
          supersedes: null,
        },
      ],
      achievements: [{ id: "rank-1", title: "Rank 1", description: "…", achieved_at: 4 }],
      stats: {
        chronicle_citations: { event: 0, narrative: 1, digest: 0, correction: 0 },
        chronicle_citations_total: 1,
        rooms_visited: 1,
        unique_commands: 2,
        entities_interacted: 3,
        total_actions: 4,
        competence_gates_passed: 0,
        days_active: 1,
      },
      connections: [{ name: "Bob", co_chronicles: 1 }],
    } satisfies Backend.EntityProfile satisfies Who.EntityProfile;
    const asWho: Who.EntityProfile = payload;
    const asBackend: Backend.EntityProfile = asWho;
    expect(asBackend.identity.name).toBe("Alice");
  });

  it("publishes the narrow-layout breakpoint as a matching media query", () => {
    expect(Who.NARROW_LAYOUT_MAX_WIDTH).toBe(640);
    expect(Who.NARROW_LAYOUT_QUERY).toBe("(max-width: 640px)");
  });
});
