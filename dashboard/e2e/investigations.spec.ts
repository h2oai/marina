// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("saved prediction, evidence canvas, research, dashboard panel and chat share authorized revisions", async ({
  page,
}) => {
  const errors: string[] = [];
  const starts: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/investigations")
      starts.push(req.url());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/predict");
  await page.getByPlaceholder("Enter your name...").fill("PredictionBrowser");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A clearer view of what comes next." }),
  ).toBeVisible();
  await page.getByRole("button", { name: /prediction Simulated: Will the release ship/ }).click();
  await expect(page.getByText("65% chance", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/marina-prediction-answer.png", fullPage: true });
  const caseId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.getByRole("tab", { name: "Evidence canvas" }).click();
  await expect(page.getByRole("region", { name: "Evidence canvas" })).toBeVisible();
  await page.getByText("Browse captured documents as a list").click();
  await page.getByRole("button", { name: "Input", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Captured document" })).toContainText(
    "Review the release checklist.",
  );
  await page.screenshot({ path: "/tmp/marina-prediction-evidence.png", fullPage: true });
  await page.getByRole("tab", { name: "Why", exact: true }).click();
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.reload();
  await expect(page.getByText("65% chance", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("65% chance", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "/tmp/marina-prediction-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("link", { name: "Open as a dashboard panel" }).click();
  await expect(
    page.getByRole("heading", { name: "Prediction & research 1", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("65% chance", { exact: true })).toBeVisible();
  const dismiss = page.getByRole("button", { name: "Dismiss getting-started guide" });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.locator("#marina-command-input").fill(`inquiry show ${caseId}`);
  await page.locator("#marina-command-input").press("Enter");
  const rich = page.getByRole("button", { name: "Rich view" });
  if (await rich.isVisible()) await rich.click();
  await expect(page.getByRole("region", { name: "Private investigation card" })).toBeVisible();
  await page.getByRole("link", { name: "Predict", exact: true }).click();
  await page.getByRole("button", { name: /research Simulated: What blocks the release/ }).click();
  await page.getByRole("tab", { name: "Report", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "Report" })).toContainText(
    "Integration is unfinished",
  );
  expect(starts).toEqual([]);
  expect(errors).toEqual([]);
});
