// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { posix } from "node:path";

export interface GuideLinkOptions {
  /** Guide files (`name.md`) published on the site; links between them stay local. */
  guides: ReadonlySet<string>;
  /** Image files under `docs/assets/`, served by the site at `${assetsBase}<file>`. */
  assets?: ReadonlySet<string>;
  /** The URL prefix the site serves `docs/assets/` from (ends with `/`). */
  assetsBase?: string;
}

/**
 * Guides stay local and an image the site serves is addressed where it is served;
 * repository-only references retain their GitHub destination.
 *
 * A guide writes `![…](../assets/x.png)`, which GitHub renders. Sent to the
 * `blob` page that link would be an HTML document, not an image, so every
 * picture on the site was broken until 2026-11-03: the asset set and its base
 * are passed in, and a known image becomes a root-relative site URL.
 */
export function rewriteGuideLinks(
  markdown: string,
  published: ReadonlySet<string> | GuideLinkOptions,
): string {
  const opts: GuideLinkOptions = "guides" in published ? published : { guides: published };
  const assetsBase = opts.assetsBase ?? "/assets/";
  return markdown.replace(
    /\]\(([A-Za-z0-9_./-]+)(#[^\s)]*)?\)/g,
    (original, target: string, anchor: string | undefined) => {
      if (target.startsWith("/")) return original;
      const path = posix.normalize(posix.join("docs/guides", target));
      if (path.startsWith("../")) return original;
      const suffix = anchor ?? "";
      if (posix.dirname(path) === "docs/guides" && opts.guides.has(posix.basename(path))) {
        return `](../${posix.basename(path, ".md")}/${suffix})`;
      }
      if (posix.dirname(path) === "docs/assets" && opts.assets?.has(posix.basename(path))) {
        return `](${assetsBase}${posix.basename(path)})`;
      }
      const kind = target.endsWith("/") ? "tree" : "blob";
      return `](https://github.com/h2oai/marina/${kind}/main/${path}${suffix})`;
    },
  );
}
