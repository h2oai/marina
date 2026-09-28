// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { reduceChatPerception } from "../lib/chat-state-reducer";

it("keeps correlated context, memory and catalog envelopes out of the public transcript", () => {
  for (const data of [
    { capabilities: { commands: [] } },
    { context_preview: { request_id: "private-request", content: "private" } },
    { memory_service: { request_id: "private-request", result: "private" } },
  ])
    expect(reduceChatPerception({ kind: "system", data })).toEqual({});
  expect(
    reduceChatPerception({ kind: "system", data: { text: "visible result" } }, 42).message?.text,
  ).toBe("visible result");
});

it("models login and authentication failure without applying browser side effects", () => {
  const login = reduceChatPerception(
    {
      kind: "system",
      data: { token: "example-token", entityId: "e_1", name: "Ada", text: "Welcome" },
    },
    42,
  );
  expect(login).toMatchObject({
    token: "example-token",
    login: { loggedIn: true, name: "Ada" },
    message: { text: "Welcome", timestamp: 42 },
  });
  expect(
    reduceChatPerception(
      { kind: "auth_error", data: { token: "must-not-restore", entityId: "e_1" } },
      42,
    ),
  ).toMatchObject({
    token: null,
    login: { loggedIn: false },
    message: { text: "Authentication failed.", kind: "system" },
  });
});

it("preserves room data and timestamps for rich rendering and plain-text copy", () => {
  const room = {
    kind: "room",
    timestamp: 17,
    data: {
      short: "Harbor",
      long: "Welcome",
      items: { map: {} },
      entities: [{ name: "Ada" }],
      exits: ["north"],
    },
  };
  const transition = reduceChatPerception(room, 42);
  expect(transition.message).toMatchObject({ kind: "room", timestamp: 17, perception: room });
  expect(transition.message?.text).toBe(
    "Harbor\nWelcome\n\nObjects: map\nPresent: Ada\nExits: north\n",
  );
  expect(
    reduceChatPerception(
      { kind: "movement", data: { entityName: "Ada", direction: "depart", exit: "north" } },
      42,
    ).message?.text,
  ).toBe("Ada leaves north.");
});
