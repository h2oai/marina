// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ConnectionManager } from "../src/engine/connection-manager";
import type { EntityId } from "../src/types";
import { MockConnection } from "./helpers";

describe("ConnectionManager.boundExternalCount", () => {
  it("tracks bind/unbind/remove transitions", () => {
    const cm = new ConnectionManager();
    cm.add(new MockConnection("c1"));
    cm.add(new MockConnection("c2"));
    expect(cm.boundExternalCount()).toBe(0);

    cm.bindEntity("c1", "e_1" as EntityId);
    cm.bindEntity("c2", "e_2" as EntityId);
    expect(cm.boundExternalCount()).toBe(2);

    cm.unbindEntity("e_1" as EntityId);
    expect(cm.boundExternalCount()).toBe(1);

    cm.remove("c2");
    expect(cm.boundExternalCount()).toBe(0);
  });

  it("excludes internal-tagged connections from the count", () => {
    const cm = new ConnectionManager();
    const external = new MockConnection("c1");
    const internal = new MockConnection("c2");
    internal.internal = true;
    cm.add(external);
    cm.add(internal);

    cm.bindEntity("c1", "e_1" as EntityId);
    cm.bindEntity("c2", "e_2" as EntityId);
    expect(cm.boundExternalCount()).toBe(1);
  });
});
