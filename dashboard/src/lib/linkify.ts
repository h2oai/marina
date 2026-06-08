/**
 * Render-time URL linkification for chat HTML.
 *
 * The server sends URLs (e.g. from the search/web tools) as plain text — this
 * is a dashboard-only rendering nicety that wraps bare http(s):// URLs in
 * anchor tags so they're clickable. It runs on the already-HTML-escaped chat
 * string (the output of ansiToHtml, or escapeHtml for plain text), so matches
 * never span a `<` and existing <span>/<br> markup is preserved. The resulting
 * HTML is still passed through sanitizeChatHtml before rendering.
 */

/** HTML-escape plain text (mirrors the per-char escaper in unified/lib/ansi.ts). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Bare http(s) URL. `[^\s<]` stops at whitespace and the start of any tag, so a
// match can never cross into `<span …>` / `<br>` produced by ansiToHtml.
const URL_RE = /https?:\/\/[^\s<]+/g;

// Trailing characters that are punctuation rather than part of the URL.
const TRAILING_PUNCT = `.,;:!?'"`;

/**
 * Peel trailing characters that are almost certainly sentence punctuation, not
 * part of the URL: a trailing HTML entity (e.g. a `&gt;` that followed the URL
 * in the source), common punctuation, and an unbalanced closing paren. Returns
 * `[url, trailing]` where `trailing` is re-appended as plain text after the link.
 */
function splitTrailing(match: string): [string, string] {
  let url = match;
  let trailing = "";
  let changed = true;
  while (changed && url.length > 0) {
    changed = false;

    // Trailing HTML entity (escaped char that came right after the URL).
    const entity = url.match(/&[a-z]+;$/i);
    if (entity) {
      trailing = entity[0] + trailing;
      url = url.slice(0, -entity[0].length);
      changed = true;
      continue;
    }

    const last = url[url.length - 1]!;
    if (TRAILING_PUNCT.includes(last)) {
      trailing = last + trailing;
      url = url.slice(0, -1);
      changed = true;
      continue;
    }

    // Closing paren only when unbalanced — more ')' than '(' means the last one
    // is sentence punctuation, not part of the URL. Keeps balanced cases like
    // https://en.wikipedia.org/wiki/Foo_(bar).
    if (last === ")") {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) {
        trailing = last + trailing;
        url = url.slice(0, -1);
        changed = true;
      }
    }
  }
  return [url, trailing];
}

/**
 * Wrap bare http(s):// URLs in the given (already HTML-escaped) string with
 * anchor tags. The same escaped substring is used for both the `href` and the
 * link text — the browser decodes entity-encoded attribute values (e.g.
 * `&amp;` in a query string) back to the real URL on navigation.
 */
export function linkifyHtml(html: string): string {
  return html.replace(URL_RE, (match) => {
    const [url, trailing] = splitTrailing(match);
    if (!url) return match;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trailing}`;
  });
}
