// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { escapeHtml, linkifyHtml } from "../lib/linkify";
import { sanitizeChatHtml } from "../lib/sanitize";

describe("linkifyHtml", () => {
  it("wraps a bare URL in a safe anchor", () => {
    const out = linkifyHtml("see https://example.com now");
    expect(out).toBe(
      'see <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a> now',
    );
  });

  it("preserves surrounding ANSI spans and only linkifies the URL", () => {
    const input = '<span style="opacity:0.6">https://example.com/path</span>';
    const out = linkifyHtml(input);
    expect(out).toContain('<span style="opacity:0.6">');
    expect(out).toContain('<a href="https://example.com/path"');
    expect(out).toContain("</span>");
  });

  it("excludes trailing sentence punctuation from the link", () => {
    const out = linkifyHtml("docs at https://example.com.");
    expect(out).toContain('href="https://example.com"');
    // The period is rendered after the closing anchor, not inside the href.
    expect(out).toContain("</a>.");
    expect(out).not.toContain('href="https://example.com."');
  });

  it("keeps balanced parens but drops an unbalanced trailing paren", () => {
    expect(linkifyHtml("(see https://en.wikipedia.org/wiki/Foo_(bar))")).toContain(
      'href="https://en.wikipedia.org/wiki/Foo_(bar)"',
    );
    expect(linkifyHtml("(https://example.com)")).toContain('href="https://example.com"');
    expect(linkifyHtml("(https://example.com)")).toContain("</a>)");
  });

  it("preserves entity-encoded query strings in the href", () => {
    // ansiToHtml/escapeHtml turn `&` into `&amp;`; the browser decodes the
    // attribute back to a real `&` on navigation, so keeping it is correct.
    const out = linkifyHtml("https://x.test/?a=1&amp;b=2");
    expect(out).toContain('href="https://x.test/?a=1&amp;b=2"');
  });

  it("leaves text without URLs untouched", () => {
    const input = "no links here, just <span>styled</span> text";
    expect(linkifyHtml(input)).toBe(input);
  });

  it("does not linkify non-http schemes", () => {
    const out = linkifyHtml("ftp://example.com and mailto:a@b.com");
    expect(out).not.toContain("<a ");
  });
});

describe("escapeHtml", () => {
  it("escapes HTML-significant characters", () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });
});

describe("sanitizeChatHtml — anchor handling", () => {
  it("keeps a linkified anchor and forces safe target/rel", () => {
    const html = sanitizeChatHtml(linkifyHtml("go to https://example.com"));
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("strips javascript: anchors (defense in depth)", () => {
    const html = sanitizeChatHtml('<a href="javascript:alert(1)">x</a>');
    expect(html).not.toContain("javascript:");
  });

  it("still strips disallowed tags", () => {
    expect(sanitizeChatHtml("<img src=x onerror=alert(1)>hi")).not.toContain("<img");
  });
});
