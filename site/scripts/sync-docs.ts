// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync the repo's user guides into Starlight's content collection at build
 * time. Keeps docs/guides/ as the single source of truth — the generated
 * copies under src/content/docs/guides/ are gitignored.
 *
 * For each guide: derive the Starlight `title` from the first H1, strip that
 * H1 (Starlight renders the title), and write the rest with frontmatter.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const SRC = join(REPO, "docs", "guides");
const DEST = join(import.meta.dir, "..", "src", "content", "docs", "docs", "guides");

// README is the guides index — Starlight's sidebar replaces it.
const SKIP = new Set(["README.md"]);

function titleFromMarkdown(md: string, fallback: string): { title: string; body: string } {
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(/^#\s+(.+?)\s*$/);
    if (m) {
      lines.splice(i, 1); // drop the H1; Starlight renders the title
      // also drop an immediately-following blank line for tidiness
      if (lines[i]?.trim() === "") lines.splice(i, 1);
      return { title: m[1]!, body: lines.join("\n").trimStart() };
    }
  }
  return { title: fallback, body: md };
}

function yamlEscape(s: string): string {
  return s.replace(/"/g, '\\"');
}

/**
 * Rewrite same-directory `guide.md` links to the routes Starlight serves.
 * In the repo, guides link to each other as `[Memory](memory.md)` — correct
 * on GitHub, but a 404 on the site where pages live at /docs/guides/<slug>/.
 * From a page directory, the sibling guide is `../<slug>/`. Anchors survive.
 * Absolute URLs, root-relative paths, and bare anchors are left untouched.
 */
function rewriteGuideLinks(md: string): string {
  return md.replace(/\]\(([A-Za-z0-9_-]+)\.md(#[^)]*)?\)/g, "](../$1/$2)");
}

if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

let count = 0;
for (const file of readdirSync(SRC)) {
  if (!file.endsWith(".md") || SKIP.has(file)) continue;
  const raw = readFileSync(join(SRC, file), "utf8");
  const slug = file.replace(/\.md$/, "");
  const { title, body } = titleFromMarkdown(raw, slug);
  const out = `---\ntitle: "${yamlEscape(title)}"\n---\n\n${rewriteGuideLinks(body)}`;
  writeFileSync(join(DEST, file), out, "utf8");
  count++;
}

console.log(`[sync-docs] wrote ${count} guides → src/content/docs/guides/`);
