import DOMPurify, { type Config } from "dompurify";

/**
 * Client-side defense-in-depth sanitizer for HTML produced by the server.
 *
 * Use at every `dangerouslySetInnerHTML` site that renders content the user
 * (or an agent) could influence. The server already sanitizes ANSI-rendered
 * chat HTML and document content; this is the second wall.
 */

const CHAT_CONFIG: Config = {
  // `a` + `href` so render-time linkified URLs (see lib/linkify.ts) survive.
  // DOMPurify's default URI allow-list still blocks javascript:/data: hrefs.
  ALLOWED_TAGS: ["span", "br", "b", "i", "u", "strong", "em", "a"],
  ALLOWED_ATTR: ["class", "style", "href"],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["target", "rel"],
};

// Force every anchor (chat or doc) to open safely in a new tab. Registered once
// at module load — the canonical DOMPurify safe-link guard.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const DOC_CONFIG: Config = {
  ALLOWED_TAGS: [
    "p",
    "br",
    "span",
    "div",
    "b",
    "i",
    "u",
    "strong",
    "em",
    "a",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "code",
    "pre",
  ],
  ALLOWED_ATTR: ["class", "style", "href", "title"],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["target", "rel"],
};

/** Sanitize ANSI-rendered chat HTML. Strips everything but inline spans + styling. */
export function sanitizeChatHtml(html: string): string {
  return DOMPurify.sanitize(html, CHAT_CONFIG);
}

/** Sanitize document/rich-text content for the canvas viewer. */
export function sanitizeDocHtml(html: string): string {
  return DOMPurify.sanitize(html, DOC_CONFIG);
}
