// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { posix } from "node:path";

/** Guides stay local; repository-only references retain their GitHub destination. */
export function rewriteGuideLinks(markdown: string, publishedGuides: ReadonlySet<string>): string {
  return markdown.replace(
    /\]\(([A-Za-z0-9_./-]+)(#[^\s)]*)?\)/g,
    (original, target: string, anchor: string | undefined) => {
      if (target.startsWith("/")) return original;
      const path = posix.normalize(posix.join("docs/guides", target));
      if (path.startsWith("../")) return original;
      const suffix = anchor ?? "";
      if (posix.dirname(path) === "docs/guides" && publishedGuides.has(posix.basename(path))) {
        return `](../${posix.basename(path, ".md")}/${suffix})`;
      }
      const kind = target.endsWith("/") ? "tree" : "blob";
      return `](https://github.com/h2oai/marina/${kind}/main/${path}${suffix})`;
    },
  );
}
