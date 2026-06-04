import { beforeEach, describe, expect, it } from "vitest";
import { useInteractions } from "../unified/hooks/use-interactions";

beforeEach(() => {
  useInteractions.setState({ interactions: [] });
});

describe("useInteractions — message body flow", () => {
  it("stores body + recipient on tell arcs", () => {
    useInteractions.getState().addInteraction("Alice", "Bob", "tell", undefined, undefined, {
      body: "split the task",
      recipient: "Bob",
    });
    const arc = useInteractions.getState().interactions[0]!;
    expect(arc.body).toBe("split the task");
    expect(arc.recipient).toBe("Bob");
    expect(arc.type).toBe("tell");
  });

  it("stores body without recipient on say arcs", () => {
    useInteractions
      .getState()
      .addInteraction("Alice", "Bob", "say", undefined, undefined, { body: "hello everyone" });
    const arc = useInteractions.getState().interactions[0]!;
    expect(arc.body).toBe("hello everyone");
    expect(arc.recipient).toBeUndefined();
  });

  it("leaves body undefined for presence/movement arcs", () => {
    useInteractions.getState().addInteraction("Alice", "Alice", "connect", undefined, "zone/lobby");
    useInteractions.getState().addInteraction("Alice", "Alice", "move", "zone/lobby", "zone/hall");
    const arcs = useInteractions.getState().interactions;
    expect(arcs[0]?.body).toBeUndefined();
    expect(arcs[1]?.body).toBeUndefined();
  });

  it("remains backwards-compatible when options are omitted", () => {
    useInteractions.getState().addInteraction("Alice", "Bob", "say");
    const arc = useInteractions.getState().interactions[0]!;
    expect(arc.body).toBeUndefined();
    expect(arc.recipient).toBeUndefined();
    expect(arc.type).toBe("say");
  });

  it("only keeps the most recent arcs when max is exceeded", () => {
    const addInteraction = useInteractions.getState().addInteraction;
    for (let i = 0; i < 45; i++) {
      addInteraction("A", "B", "say", undefined, undefined, { body: `m${i}` });
    }
    const arcs = useInteractions.getState().interactions;
    expect(arcs.length).toBe(40);
    expect(arcs[0]?.body).toBe("m5");
    expect(arcs[39]?.body).toBe("m44");
  });
});
