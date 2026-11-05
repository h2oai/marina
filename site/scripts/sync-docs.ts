// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync the repo's user guides into Starlight's content collection at build
 * time. Keeps docs/guides/ as the single source of truth — the generated
 * copies under src/content/docs/docs/guides/ are gitignored.
 *
 * For each guide: derive the Starlight `title` from the first H1, strip that
 * H1 (Starlight renders the title), and write the rest with frontmatter.
 *
 * A few pages outside docs/guides/ are published too (`PAGES`, at the same
 * repository path under docs/), with their links resolved from where they live.
 *
 * The guides' pictures live in docs/assets/; they are copied to public/assets/
 * (gitignored too) and every `../assets/<file>` reference is rewritten to the
 * URL the site serves it from, under SITE_BASE.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { rewriteGuideLinks } from "./guide-links";

const REPO = join(import.meta.dir, "..", "..");
const SRC = join(REPO, "docs", "guides");
const ASSETS_SRC = join(REPO, "docs", "assets");
const DOCS_DEST = join(import.meta.dir, "..", "src", "content", "docs");
const DEST = join(DOCS_DEST, "docs", "guides");
/** Published pages outside docs/guides/, by repository path; each is gitignored where it lands. */
const PAGES = ["docs/architecture/overview.md"];
const ASSETS_DEST = join(import.meta.dir, "..", "public", "assets");
// A second copy under src/ for pages that import a picture (the overview hero); gitignored too.
const ASSETS_SRC_DEST = join(import.meta.dir, "..", "src", "assets", "docs");

// README is the guides index — Starlight's sidebar replaces it.
const SKIP = new Set(["README.md"]);
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|mp4|webm)$/i;

/** The site's base path as astro.config.mjs reads it, with one trailing slash. */
function siteBase(): string {
  const raw = process.env.SITE_BASE ?? "/";
  const withLead = raw.startsWith("/") ? raw : `/${raw}`;
  return withLead.endsWith("/") ? withLead : `${withLead}/`;
}

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

if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
for (const page of PAGES) rmSync(join(DOCS_DEST, page), { force: true });
for (const dir of [ASSETS_DEST, ASSETS_SRC_DEST]) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

const assets = new Set(
  existsSync(ASSETS_SRC) ? readdirSync(ASSETS_SRC).filter((file) => IMAGE.test(file)) : [],
);
for (const file of assets) {
  copyFileSync(join(ASSETS_SRC, file), join(ASSETS_DEST, file));
  copyFileSync(join(ASSETS_SRC, file), join(ASSETS_SRC_DEST, file));
}

const guides = new Set(readdirSync(SRC).filter((file) => file.endsWith(".md") && !SKIP.has(file)));
const assetsBase = `${siteBase()}assets/`;
const pages = new Set(PAGES);
let count = 0;
for (const file of guides) {
  const raw = readFileSync(join(SRC, file), "utf8");
  const slug = file.replace(/\.md$/, "");
  const { title, body } = titleFromMarkdown(raw, slug);
  const out = `---\ntitle: "${yamlEscape(title)}"\n---\n\n${rewriteGuideLinks(body, { guides, assets, assetsBase, pages })}`;
  writeFileSync(join(DEST, file), out, "utf8");
  count++;
}
for (const page of PAGES) {
  const { title, body } = titleFromMarkdown(readFileSync(join(REPO, page), "utf8"), page);
  const links = rewriteGuideLinks(body, { guides, assets, assetsBase, pages, from: dirname(page) });
  const dest = join(DOCS_DEST, page);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, `---\ntitle: "${yamlEscape(title)}"\n---\n\n${links}`, "utf8");
  count++;
}

console.log(
  `[sync-docs] wrote ${count} pages (guides + ${PAGES.length} more) → src/content/docs/docs/, ${assets.size} assets → public/assets/ (served at ${assetsBase})`,
);
