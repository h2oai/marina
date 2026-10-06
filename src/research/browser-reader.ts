// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Rendered page reads for research runs, OPT-IN: a headless Chromium through the
 * optional `playwright-core` dependency, used only when a plain guarded fetch
 * failed or returned a script shell. Without `playwright-core` or a Chromium
 * build (`bunx playwright-core install chromium-headless-shell`), `openBrowser`
 * returns undefined and reads stay plain fetches — nothing else changes.
 *
 * Outbound policy: every request the page makes (document, script, XHR, …)
 * is checked with `validateFetchUrl` before it leaves (private, loopback,
 * link-local and metadata addresses refused, as for every other fetch);
 * images, media and fonts are not loaded; WebSockets are closed; downloads are
 * refused; each read gets a fresh context (no cookies or storage carried over).
 * Residual risk, documented: Chromium resolves DNS itself after the check, so
 * the DNS-pinning that `guardedFetch` does is not available here — which is one
 * reason the path is opt-in.
 */

import { getErrorMessage } from "../engine/errors";
import { validateFetchUrl } from "../net/url-guard";

export interface RenderedPage {
  ok: boolean;
  status: number;
  /** URL after redirects. */
  finalUrl: string;
  title?: string;
  html: string;
  /** `document.body.innerText` — what a reader sees. */
  text: string;
  /** JPEG of the first screen. */
  screenshot?: Uint8Array;
  error?: string;
}

export interface RenderOptions {
  /** The caller's own policy: a request (document, redirect hop, XHR…) it refuses is aborted. */
  refuse?: (url: string) => boolean;
}

export interface BrowserReader {
  render(url: string, opts?: RenderOptions): Promise<RenderedPage>;
  close(): Promise<void>;
}

export interface BrowserOptions {
  timeoutMs?: number;
  /** Pages rendered at once. */
  concurrency?: number;
  userAgent?: string;
  /** Injected for tests: the URL check applied to every request. */
  check?: (url: string) => Promise<string | null>;
}

const BLOCKED_TYPES = new Set(["image", "media", "font"]);

/** True when a plain read looks like a page that needs a browser (empty shell, bot wall). */
export function needsRender(read: {
  ok: boolean;
  status: number;
  text: string;
  kind: string;
}): boolean {
  if (read.kind === "pdf") return false;
  // Any failure but "not there" may be a bot wall or a script-only page.
  if (!read.ok) return read.status !== 404 && read.status !== 410;
  const t = read.text.trim();
  if (t.length < 600) return true;
  return /enable javascript|javascript is (disabled|required)|are you a robot|verify you are human|captcha|access denied|checking your browser|just a moment/i.test(
    t.slice(0, 3000),
  );
}

/**
 * Launch a shared headless Chromium, or undefined when `playwright-core` or a
 * Chromium build is missing.
 */
export async function openBrowser(opts: BrowserOptions = {}): Promise<BrowserReader | undefined> {
  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    return undefined;
  }
  let browser: import("playwright-core").Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    return undefined;
  }
  const check = opts.check ?? validateFetchUrl;
  const timeout = opts.timeoutMs ?? 30_000;
  const limit = Math.max(1, opts.concurrency ?? 3);
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = async () => {
    while (active >= limit) await new Promise<void>((r) => waiters.push(r));
    active++;
  };
  const release = () => {
    active--;
    waiters.shift()?.();
  };

  async function render(url: string, ro: RenderOptions = {}): Promise<RenderedPage> {
    if (ro.refuse?.(url))
      return { ok: false, status: 0, finalUrl: url, html: "", text: "", error: "refused" };
    const first = await check(url);
    if (first) return { ok: false, status: 0, finalUrl: url, html: "", text: "", error: first };
    await acquire();
    const context = await browser.newContext({
      acceptDownloads: false,
      javaScriptEnabled: true,
      viewport: { width: 1280, height: 1600 },
      ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
    });
    try {
      await context.route("**/*", async (route) => {
        // Requests still in flight when the read ends (context closed) reject;
        // that is the end of the read, not an error.
        try {
          const req = route.request();
          const u = req.url();
          if (u.startsWith("data:") || u.startsWith("blob:")) return await route.continue();
          if (BLOCKED_TYPES.has(req.resourceType())) return await route.abort("blockedbyclient");
          if (ro.refuse?.(u)) return await route.abort("blockedbyclient");
          const refused = await check(u);
          if (refused) return await route.abort("blockedbyclient");
          // Fetch without following redirects and hand the response to the page:
          // a redirect then comes back through this handler as a new request, so
          // every hop is checked (Chromium would otherwise follow it unrouted).
          const response = await route.fetch({ maxRedirects: 0, timeout });
          await route.fulfill({ response });
        } catch {
          await route.abort("failed").catch(() => undefined);
        }
      });
      await context.routeWebSocket(/.*/, (ws) => ws.close());
      const page = await context.newPage();
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
      const status = res?.status() ?? 0;
      const html = await page.content();
      const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      const title = await page.title().catch(() => undefined);
      const screenshot = await page
        .screenshot({ type: "jpeg", quality: 60, fullPage: false, timeout: 10_000 })
        .catch(() => undefined);
      return {
        ok: status >= 200 && status < 300,
        status,
        finalUrl: page.url(),
        ...(title ? { title } : {}),
        html,
        text,
        ...(screenshot ? { screenshot: new Uint8Array(screenshot) } : {}),
        ...(status >= 200 && status < 300 ? {} : { error: `HTTP ${status}` }),
      };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        finalUrl: url,
        html: "",
        text: "",
        error: getErrorMessage(e).slice(0, 200),
      };
    } finally {
      await context.close().catch(() => undefined);
      release();
    }
  }

  return {
    render,
    close: () => browser.close().catch(() => undefined),
  };
}
