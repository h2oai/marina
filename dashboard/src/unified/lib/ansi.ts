// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * ANSI escape code → HTML converter.
 *
 * The Marina server sends terminal-style ANSI color codes in text responses.
 * This converts them to styled <span> elements for rendering in the browser.
 */

const ANSI_COLORS: Record<string, string> = {
  "30": "#4d4d4d",
  "31": "#f44",
  "32": "#4e4",
  "33": "#fd0",
  "34": "#69f",
  "35": "#f6f",
  "36": "#0ff",
  "37": "#d4d4d4",
  "90": "#888",
  "91": "#f66",
  "92": "#8f8",
  "93": "#ff5",
  "94": "#8af",
  "95": "#f8f",
  "96": "#5ff",
  "97": "#fff",
};

// 256-color support: ESC[38;5;Nm
function color256(n: number): string | null {
  if (n < 8) {
    return ["#4d4d4d", "#f44", "#4e4", "#fd0", "#69f", "#f6f", "#0ff", "#d4d4d4"][n] ?? null;
  }
  if (n < 16) {
    return ["#888", "#f66", "#8f8", "#ff5", "#8af", "#f8f", "#5ff", "#fff"][n - 8] ?? null;
  }
  if (n < 232) {
    const idx = n - 16;
    const r = Math.floor(idx / 36) * 51;
    const g = (Math.floor(idx / 6) % 6) * 51;
    const b = (idx % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  // Grayscale
  const level = (n - 232) * 10 + 8;
  return `rgb(${level},${level},${level})`;
}

function escHtml(ch: string): string {
  if (ch === "&") return "&amp;";
  if (ch === "<") return "&lt;";
  if (ch === ">") return "&gt;";
  if (ch === '"') return "&quot;";
  return ch;
}

/** Convert ANSI-escaped text to HTML with inline styles. */
export function ansiToHtml(text: string): string {
  let result = "";
  let i = 0;
  let openSpans = 0;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i + 2);
      if (end === -1) {
        result += escHtml(text[i]!);
        i++;
        continue;
      }
      const codes = text.substring(i + 2, end).split(";");
      i = end + 1;
      const styles: string[] = [];
      for (let ci = 0; ci < codes.length; ci++) {
        const code = codes[ci]!;
        if (code === "0" || code === "") {
          while (openSpans > 0) {
            result += "</span>";
            openSpans--;
          }
        } else if (code === "1") {
          styles.push("font-weight:bold");
        } else if (code === "3") {
          styles.push("font-style:italic");
        } else if (code === "4") {
          styles.push("text-decoration:underline");
        } else if (code === "38" && codes[ci + 1] === "5" && codes[ci + 2]) {
          // 256-color foreground: ESC[38;5;Nm
          const c = color256(Number(codes[ci + 2]));
          if (c) styles.push(`color:${c}`);
          ci += 2;
        } else if (ANSI_COLORS[code]) {
          styles.push(`color:${ANSI_COLORS[code]}`);
        }
      }
      if (styles.length > 0) {
        result += `<span style="${styles.join(";")}">`;
        openSpans++;
      }
    } else if (text[i] === "\n") {
      result += "<br>";
      i++;
    } else {
      result += escHtml(text[i]!);
      i++;
    }
  }
  while (openSpans > 0) {
    result += "</span>";
    openSpans--;
  }
  return result;
}

/** Strip all ANSI escape codes from text, returning plain text. */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires ESC control char
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
