// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { decodeEntities, extractReadableText } from "../src/engine/html-text";

describe("decodeEntities", () => {
  it("decodes named and numeric references", () => {
    expect(decodeEntities("a &lt;b&gt; &quot;c&quot; &#39;d&#39;&nbsp;&#65;&#x42;")).toBe(
      "a <b> \"c\" 'd' AB",
    );
  });

  it("decodes &amp; last so an escaped entity is not decoded twice", () => {
    expect(decodeEntities("&amp;lt;tag&amp;gt; &amp; more")).toBe("&lt;tag&gt; & more");
  });
});

describe("extractReadableText", () => {
  it("keeps the title and article text, drops scripts and navigation", () => {
    const body = "Readable paragraph text. ".repeat(12);
    const html =
      "<html><head><title> My  Page </title><script>track()</script></head><body>" +
      "<nav>Home | About</nav>" +
      `<article><h2>Heading</h2><p>${body}</p><ul><li>one</li><li>two</li></ul></article>` +
      "<footer>© footer</footer></body></html>";
    const out = extractReadableText(html);
    expect(out.title).toBe("My Page");
    expect(out.text).toContain("## Heading");
    expect(out.text).toContain("- one");
    expect(out.text).not.toContain("track()");
    expect(out.text).not.toContain("Home | About");
    expect(out.text).not.toContain("footer");
    expect(out.wordCount).toBeGreaterThan(30);
  });
});
