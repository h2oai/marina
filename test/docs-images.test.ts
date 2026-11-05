// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Every picture the public docs show exists, and the site serves it as a
 * picture. A guide writes `![…](../assets/x.png)`; GitHub renders that, and
 * the site build rewrites it to the copy under `public/assets/`. Until
 * 2026-11-03 the site sent those links to GitHub's `blob` page, an HTML
 * document, so every screenshot on the published guides was broken.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { rewriteGuideLinks } from "../site/scripts/guide-links";

const ROOT = resolve(import.meta.dir, "..");

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...markdownFiles(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Image references in a markdown file: `![alt](path)` and `<img src="path">`, relative only. */
function imageRefs(text: string): string[] {
  const refs: string[] = [];
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) refs.push(m[1]!);
  for (const m of text.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) refs.push(m[1]!);
  return refs.filter((r) => !/^(https?:)?\/\//.test(r) && !r.startsWith("data:"));
}

describe("docs images", () => {
  it("every relative image reference in the public docs resolves to a file", () => {
    const files = [join(ROOT, "README.md"), ...markdownFiles(join(ROOT, "docs"))];
    const missing: string[] = [];
    for (const file of files) {
      for (const ref of imageRefs(readFileSync(file, "utf8"))) {
        const target = resolve(dirname(file), ref.split("#")[0]!);
        if (!existsSync(target)) missing.push(`${file.slice(ROOT.length + 1)} → ${ref}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the site rewrites a guide's asset reference to the served copy, never to a GitHub page", () => {
    const guides = new Set(["dashboard.md"]);
    const assets = new Set(["work-inbox.png"]);
    const md =
      "![Work inbox](../assets/work-inbox.png) and [guide](dashboard.md) and [src](../../src/x.ts)";
    expect(rewriteGuideLinks(md, { guides, assets, assetsBase: "/marina/assets/" })).toBe(
      "![Work inbox](/marina/assets/work-inbox.png) and [guide](../dashboard/) and [src](https://github.com/h2oai/marina/blob/main/src/x.ts)",
    );
    // An image the site does not hold keeps its repository destination.
    expect(rewriteGuideLinks("![x](../assets/missing.png)", { guides, assets })).toContain(
      "github.com/h2oai/marina/blob/main/docs/assets/missing.png",
    );
    // The old one-argument form still works for callers that pass only the guide set.
    expect(rewriteGuideLinks("[g](dashboard.md)", guides)).toBe("[g](../dashboard/)");
  });

  it("a published page outside the guides resolves its links from where it lives", () => {
    const guides = new Set(["dashboard.md"]);
    const assets = new Set(["architecture-system.svg"]);
    const pages = new Set(["docs/architecture/overview.md"]);
    const from = "docs/architecture";
    const md =
      "![System](../assets/architecture-system.svg) [guide](../guides/dashboard.md#x) [deep dive](memory.md#y) [rules](../../CLAUDE.md#key-files)";
    expect(
      rewriteGuideLinks(md, { guides, assets, assetsBase: "/marina/assets/", pages, from }),
    ).toBe(
      "![System](/marina/assets/architecture-system.svg) [guide](../../guides/dashboard/#x) [deep dive](https://github.com/h2oai/marina/blob/main/docs/architecture/memory.md#y) [rules](https://github.com/h2oai/marina/blob/main/CLAUDE.md#key-files)",
    );
    // …and a guide that links to it reaches its site page.
    expect(rewriteGuideLinks("[d](../architecture/overview.md#z)", { guides, pages })).toBe(
      "[d](../../architecture/overview/#z)",
    );
  });

  it("every image a published architecture page references is one the site build copies", () => {
    const assets = new Set(readdirSync(join(ROOT, "docs", "assets")));
    const file = join(ROOT, "docs", "architecture", "overview.md");
    const stray = imageRefs(readFileSync(file, "utf8")).filter((ref) => {
      const m = ref.match(/^\.\.\/assets\/([^/]+)$/);
      return !m || !assets.has(m[1]!);
    });
    expect(stray).toEqual([]);
  });

  it("every image a guide references is one the site build copies (docs/assets, image type)", () => {
    const assets = new Set(readdirSync(join(ROOT, "docs", "assets")));
    const stray: string[] = [];
    for (const file of markdownFiles(join(ROOT, "docs", "guides"))) {
      for (const ref of imageRefs(readFileSync(file, "utf8"))) {
        const m = ref.match(/^\.\.\/assets\/([^/]+)$/);
        if (!m || !assets.has(m[1]!)) stray.push(`${file.slice(ROOT.length + 1)} → ${ref}`);
      }
    }
    expect(stray).toEqual([]);
  });
});
