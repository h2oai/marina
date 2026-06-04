import { describe, expect, it } from "vitest";
import { groupMessagesByPartner } from "../components/EntityRoster";
import type { ActivityItem } from "../hooks/use-entity-activity";

function item(partial: Partial<ActivityItem> & { kind: ActivityItem["kind"] }): ActivityItem {
  return { body: "", timestamp: 0, ...partial };
}

describe("groupMessagesByPartner", () => {
  it("groups tells by recipient", () => {
    const items: ActivityItem[] = [
      item({ kind: "tell", recipient: "Bob", body: "hi", timestamp: 3 }),
      item({ kind: "tell", recipient: "Bob", body: "again", timestamp: 2 }),
      item({ kind: "tell", recipient: "Alice", body: "yo", timestamp: 1 }),
    ];
    const threads = groupMessagesByPartner(items);
    expect(threads.length).toBe(2);
    const bob = threads.find((t) => t.partner === "Bob")!;
    expect(bob.kind).toBe("entity");
    expect(bob.items.length).toBe(2);
    expect(bob.items[0]?.body).toBe("hi");
  });

  it("groups says by room short-name", () => {
    const items: ActivityItem[] = [
      item({ kind: "say", room: "zone/lobby", body: "hello", timestamp: 2 }),
      item({ kind: "say", room: "zone/lobby", body: "folks", timestamp: 1 }),
      item({ kind: "say", room: "zone/hall", body: "hey", timestamp: 3 }),
    ];
    const threads = groupMessagesByPartner(items);
    expect(threads.length).toBe(2);
    expect(threads.map((t) => t.partner).sort()).toEqual(["hall", "lobby"]);
    expect(threads.every((t) => t.kind === "room")).toBe(true);
  });

  it("groups shouts and broadcasts under `world`", () => {
    const items: ActivityItem[] = [
      item({ kind: "shout", body: "HEY", timestamp: 2 }),
      item({ kind: "broadcast", body: "news", timestamp: 1 }),
    ];
    const threads = groupMessagesByPartner(items);
    expect(threads.length).toBe(1);
    expect(threads[0]?.partner).toBe("world");
    expect(threads[0]?.kind).toBe("world");
    expect(threads[0]?.items.length).toBe(2);
  });

  it("drops non-message kinds (thought, text)", () => {
    const items: ActivityItem[] = [
      item({ kind: "thought", body: "pondering", timestamp: 3 }),
      item({ kind: "text", body: "output", timestamp: 2 }),
      item({ kind: "say", room: "zone/lobby", body: "hi", timestamp: 1 }),
    ];
    const threads = groupMessagesByPartner(items);
    expect(threads.length).toBe(1);
    expect(threads[0]?.kind).toBe("room");
  });

  it("drops tells with no recipient", () => {
    const items: ActivityItem[] = [
      item({ kind: "tell", body: "no target", timestamp: 1 }), // no recipient
    ];
    expect(groupMessagesByPartner(items)).toEqual([]);
  });

  it("sorts threads by most recent message descending", () => {
    const items: ActivityItem[] = [
      item({ kind: "tell", recipient: "Alice", body: "old", timestamp: 1 }),
      item({ kind: "tell", recipient: "Bob", body: "newer", timestamp: 3 }),
      item({ kind: "tell", recipient: "Carol", body: "mid", timestamp: 2 }),
    ];
    const threads = groupMessagesByPartner(items);
    expect(threads.map((t) => t.partner)).toEqual(["Bob", "Carol", "Alice"]);
  });

  it("caps each thread at maxPerThread items (default 3)", () => {
    const items: ActivityItem[] = Array.from({ length: 10 }, (_, i) =>
      item({ kind: "tell", recipient: "Bob", body: `msg${i}`, timestamp: 100 - i }),
    );
    const threads = groupMessagesByPartner(items);
    expect(threads[0]?.items.length).toBe(3);
    // Respects the first-come order (items come in newest-first from the store,
    // and we keep the first N we see)
    expect(threads[0]?.items.map((i) => i.body)).toEqual(["msg0", "msg1", "msg2"]);
  });

  it("returns empty for empty input", () => {
    expect(groupMessagesByPartner([])).toEqual([]);
  });

  it("falls back to raw room id when there's no slash", () => {
    const items: ActivityItem[] = [item({ kind: "say", room: "solo", body: "hi", timestamp: 1 })];
    const threads = groupMessagesByPartner(items);
    expect(threads[0]?.partner).toBe("solo");
  });
});
