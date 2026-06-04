import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { EntityRoster } from "../components/EntityRoster";
import { useEntityActivity } from "../hooks/use-entity-activity";
import { useWorldState } from "../hooks/use-world-state";
import { renderWithProviders, resetWorldState } from "./test-utils";

beforeEach(() => {
  resetWorldState();
});

describe("EntityRoster", () => {
  it("renders without crashing with empty entity list", () => {
    const { container } = renderWithProviders(<EntityRoster />);
    expect(container).toBeTruthy();
  });

  it("shows empty state message when no entities", () => {
    renderWithProviders(<EntityRoster />);
    expect(screen.getByText("No entities online")).toBeInTheDocument();
  });

  it("renders the Entities panel title", () => {
    renderWithProviders(<EntityRoster />);
    expect(screen.getByText("Entities")).toBeInTheDocument();
  });

  it("renders entity names when entities are present", () => {
    useWorldState.setState({
      entities: [
        { id: "e_1", name: "Alice", kind: "agent", room: "zone/lobby" },
        { id: "e_2", name: "Bob", kind: "npc", room: "zone/hall" },
        { id: "e_3", name: "Chest", kind: "object", room: "zone/lobby" },
      ],
    });

    renderWithProviders(<EntityRoster />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Chest")).toBeInTheDocument();
  });

  it("shows room short names alongside entities", () => {
    useWorldState.setState({
      entities: [{ id: "e_1", name: "Alice", kind: "agent", room: "zone/lobby" }],
    });

    renderWithProviders(<EntityRoster />);
    // The room is displayed as the second part after "/" split
    expect(screen.getByText("lobby")).toBeInTheDocument();
  });

  it("sorts agents before other entity kinds", () => {
    useWorldState.setState({
      entities: [
        { id: "e_1", name: "Zebra", kind: "npc", room: "zone/lobby" },
        { id: "e_2", name: "Alpha", kind: "agent", room: "zone/hall" },
      ],
    });

    renderWithProviders(<EntityRoster />);
    const buttons = screen.getAllByRole("button");
    // The agent (Alpha) should appear before the npc (Zebra)
    const names = buttons
      .map((b) => b.textContent)
      .filter((t) => t?.includes("Alpha") || t?.includes("Zebra"));
    expect(names[0]).toContain("Alpha");
    expect(names[1]).toContain("Zebra");
  });

  it("surfaces the latest `say` body as a snippet under the entity name", () => {
    useWorldState.setState({
      entities: [{ id: "e_1", name: "Alice", kind: "agent", room: "zone/lobby" }],
    });
    useEntityActivity.getState().applyEvent({
      type: "say",
      entity: "Alice",
      input: "say we should split the task",
      room: "zone/lobby",
      timestamp: Date.now(),
    });

    renderWithProviders(<EntityRoster />);
    expect(screen.getByText("we should split the task")).toBeInTheDocument();
  });

  it("surfaces a streaming text delta as a live snippet (before turn_end)", () => {
    useWorldState.setState({
      entities: [{ id: "e_1", name: "Alice", kind: "agent", room: "zone/lobby" }],
    });
    const apply = useEntityActivity.getState().applyEvent;
    apply({ type: "agent_turn_start", name: "Alice", timestamp: 100 });
    apply({
      type: "agent_text_delta",
      name: "Alice",
      delta: "mid-thought output",
      timestamp: 110,
    });

    renderWithProviders(<EntityRoster />);
    expect(screen.getByText("mid-thought output")).toBeInTheDocument();
  });

  it("renders entities with agent status indicators", () => {
    useWorldState.setState({
      entities: [
        {
          id: "e_1",
          name: "Agent-1",
          kind: "agent",
          room: "zone/lobby",
          agentStatus: {
            state: "running",
            model: "openai/gpt-4",
            role: "general",
            focus: null,
            uptime: 1000,
            toolCalls: 5,
            errors: 0,
            errorReason: null,
          },
        },
      ],
    });

    renderWithProviders(<EntityRoster />);
    expect(screen.getByText("Agent-1")).toBeInTheDocument();
    // The model name is split on "/" and shows the second part
    expect(screen.getByText("gpt-4")).toBeInTheDocument();
  });
});
