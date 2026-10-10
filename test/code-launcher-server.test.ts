// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Launcher checks that talk to a (local, fake) server: kept out of the fast,
// engine-free selection because they listen on a port.

import { describe, expect, it } from "bun:test";

describe("the provider check asks the server", () => {
  const serve = (handler: () => Response) => Bun.serve({ port: 0, fetch: handler });
  it("warns only when the server says it has no model provider", async () => {
    const { serverHasModel } = await import("../scripts/code");
    const yes = serve(() => Response.json({ hasLlmKey: true }));
    const no = serve(() => Response.json({ hasLlmKey: false }));
    const broken = serve(() => new Response("boom", { status: 500 }));
    try {
      expect(await serverHasModel(yes.port!)).toBe(true);
      expect(await serverHasModel(no.port!)).toBe(false);
      // Unknown is never a warning: no guess is shown as a fact.
      expect(await serverHasModel(broken.port!)).toBe(true);
    } finally {
      yes.stop(true);
      no.stop(true);
      broken.stop(true);
    }
  });
});
