// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { until } from "../../test/helpers";
import { createQuitHandler } from "../src/bun/quit-handler";

test("native quit vetoes synchronously, drains once, then permits native teardown", async () => {
  const release = Promise.withResolvers<void>();
  let drains = 0;
  let quits = 0;
  const failures: unknown[] = [];
  const quit = createQuitHandler(
    async () => {
      drains++;
      await release.promise;
    },
    () => {
      quits++;
    },
    (error) => failures.push(error),
  );
  const first = { response: undefined as { allow: boolean } | undefined };
  quit(first);
  expect(first.response?.allow).toBe(false);
  quit({ response: undefined });
  await until(() => drains === 1);
  expect(quits).toBe(0);
  release.resolve();
  await until(() => quits === 1);
  const final = { response: undefined as { allow: boolean } | undefined };
  quit(final);
  expect(final.response).toBeUndefined();
  expect(drains).toBe(1);
  expect(failures).toEqual([]);
});

test("failed draining keeps the app open and permits a later retry", async () => {
  let drains = 0;
  let quits = 0;
  const failures: unknown[] = [];
  const quit = createQuitHandler(
    async () => {
      if (++drains === 1) throw new Error("drain failed");
    },
    () => {
      quits++;
    },
    (error) => failures.push(error),
  );
  quit({ response: undefined });
  await until(() => failures.length === 1);
  expect(quits).toBe(0);
  quit({ response: undefined });
  await until(() => quits === 1);
  expect(drains).toBe(2);
});
