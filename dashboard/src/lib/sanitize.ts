import DOMPurify, { type Config } from "dompurify";

/**
 * Client-side defense-in-depth sanitizer for HTML produced by the server.
 *
 * Use at every `dangerouslySetInnerHTML` site that renders content the user
 * (or an agent) could influence. The server already sanitizes ANSI-rendered
 * chat HTML and document content; this is the second wall.
 */

const CHAT_CONFIG: Config = {
  ALLOWED_TAGS: ["span", "br", "b", "i", "u", "strong", "em"],
  ALLOWED_ATTR: ["class", "style"],
  ALLOW_DATA_ATTR: false,
};

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
