// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test";

test("hosted provider models show token prices and persist the selected default", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let selected = "together/MiniMaxAI/MiniMax-M3";
  let refreshed = false;
  await page.route("**/api/models*", async (route) => {
    refreshed ||= new URL(route.request().url()).searchParams.get("refresh") === "1";
    await route.fulfill({
      json: {
        groups: ["together", "nebius"].map((provider) => ({
          provider,
          keySource: "env",
          error: null,
          models: [
            {
              value: `${provider}/MiniMaxAI/MiniMax-M3`,
              label: "MiniMax M3",
              contextLength: 524288,
              pricing: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.3 },
            },
          ],
        })),
      },
    });
  });
  await page.route("**/api/keys", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/default-model", async (route) => {
    if (route.request().method() === "PUT") selected = route.request().postDataJSON().model;
    await route.fulfill({ json: { model: selected, configured: selected } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard?view=admin");
  await page.getByRole("button", { name: "Dismiss getting-started guide" }).click();
  const picker = page.getByRole("combobox", { name: /Default model/ });
  await expect(picker).toHaveValue(selected);
  await expect(picker.locator('optgroup[label="Together AI"]')).toHaveCount(1);
  await expect(picker.locator('optgroup[label="Nebius Token Factory"]')).toHaveCount(1);
  await expect(picker.locator('option[value="nebius/MiniMaxAI/MiniMax-M3"]')).toHaveText(
    "Nebius Token Factory · MiniMax M3 · $0.3/$1.2 per 1M in/out",
  );
  await picker.selectOption("nebius/MiniMaxAI/MiniMax-M3");
  await expect.poll(() => selected).toBe("nebius/MiniMaxAI/MiniMax-M3");
  await page.getByRole("button", { name: "Refresh model catalog" }).click();
  await expect.poll(() => refreshed).toBe(true);
  await page.screenshot({ path: test.info().outputPath("hosted-providers.png"), fullPage: true });
  await page.reload();
  await expect(picker).toHaveValue("nebius/MiniMaxAI/MiniMax-M3");
  expect(errors).toEqual([]);
});
