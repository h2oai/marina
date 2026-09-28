// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DecisionSettingRow, DecisionSettings } from "../components/ops/DecisionSettings";
import { DecisionsSection } from "../components/ops/DecisionsSection";
import type { OpsDecisions } from "../lib/ops-types";

const rows: DecisionSettingRow[] = [
  {
    name: "backend",
    env: "MARINA_DECISIONS",
    describe: "decision backend",
    source: "default",
    locked: false,
    options: ["off", "decisions-api", "jev"],
  },
  {
    name: "model",
    env: "MARINA_DECISION_MODEL",
    describe: "backend model id",
    value: "typesafe/jev-1.13",
    source: "environment",
    locked: true,
  },
  {
    name: "gate",
    env: "MARINA_DECISION_GATE",
    describe: "gate",
    value: "on",
    source: "runtime",
    locked: false,
    options: ["on", "off"],
  },
];

function mockApi(put: (body: unknown) => Response) {
  const calls: Array<{ method: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, body });
      if (method === "PUT") return put(body);
      return new Response(JSON.stringify({ settings: rows, history: [], runtime: true }));
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

/** Under a loaded full-suite run each async step needs more than the default 1 s. */
const SLOW = { timeout: 5_000 };

/** Pick a value for a setting and press its Save once the button is enabled. */
async function changeAndSave(name: string, env: string, value: string) {
  const select = await screen.findByLabelText(`${name} (${env})`, undefined, SLOW);
  fireEvent.change(select, { target: { value } });
  const save = screen.getByLabelText(`Save ${name} (${env})`);
  await waitFor(() => expect(save).not.toBeDisabled(), SLOW);
  fireEvent.click(save);
}

describe("Ops → Decisions → settings", () => {
  it("lists every setting; an environment value is locked, not editable", async () => {
    mockApi(() => new Response("{}"));
    render(<DecisionSettings />);
    await screen.findByText("backend");
    expect(screen.getByLabelText("backend (MARINA_DECISIONS)")).toBeInTheDocument();
    expect(screen.queryByLabelText("model (MARINA_DECISION_MODEL)")).toBeNull();
    expect(screen.getByText("env · locked")).toBeInTheDocument();
    expect(screen.getByText("typesafe/jev-1.13")).toBeInTheDocument();
  });

  it("saves a change with PUT { setting, value } and reports it", async () => {
    const calls = mockApi(() => new Response(JSON.stringify({ setting: rows[0] })));
    const onChanged = vi.fn();
    render(<DecisionSettings onChanged={onChanged} />);
    await changeAndSave("backend", "MARINA_DECISIONS", "jev");
    expect(await screen.findByText("✓ backend updated", undefined, SLOW)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      setting: "backend",
      value: "jev",
    });
  });

  it("reset clears a runtime value (value null)", async () => {
    const calls = mockApi(() => new Response(JSON.stringify({ setting: rows[2] })));
    render(<DecisionSettings />);
    fireEvent.click(
      await screen.findByLabelText(
        "Reset gate (MARINA_DECISION_GATE) to its default",
        undefined,
        SLOW,
      ),
    );
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true), SLOW);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ setting: "gate", value: null });
  });

  it("shows the server's reason when a change is refused", async () => {
    mockApi(
      () =>
        new Response(
          JSON.stringify({
            error: "An agent never changes the decision settings that supervise it.",
          }),
          {
            status: 403,
          },
        ),
    );
    render(<DecisionSettings />);
    await changeAndSave("backend", "MARINA_DECISIONS", "jev");
    expect(await screen.findByRole("alert", undefined, SLOW)).toHaveTextContent(
      "An agent never changes",
    );
  });

  it("a network failure is shown, never thrown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    render(<DecisionSettings />);
    expect(await screen.findByText("network down", undefined, SLOW)).toBeInTheDocument();
  });

  it("operators can turn decisions on from the section even while they are off", async () => {
    mockApi(() => new Response("{}"));
    const off: OpsDecisions = {
      configured: false,
      backend: null,
      model: null,
      calibrated: true,
      gate: false,
      verify: false,
      windowMs: 86_400_000,
      counts: {},
      recent: [],
      health: { status: "ok", total: 0, errors: 0 },
    } as unknown as OpsDecisions;
    const { unmount } = render(<DecisionsSection decisions={off} privileged />);
    expect(await screen.findByLabelText("backend (MARINA_DECISIONS)")).toBeInTheDocument();
    unmount();
    render(<DecisionsSection decisions={off} />);
    expect(screen.queryByLabelText("backend (MARINA_DECISIONS)")).toBeNull();
  });
});
