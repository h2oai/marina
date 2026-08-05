const SECRET_TERM = /(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|authorization)/i;
const SECRET_FIELD = `[a-z0-9_-]*(?:${SECRET_TERM.source})[a-z0-9_-]*`;
const SECRET_ASSIGNMENT = new RegExp(`\\b(${SECRET_FIELD})\\s*[:=]\\s*([^\\s,;]+)`, "gi");
const SECRET_JSON = new RegExp(`(["']${SECRET_FIELD}["']\\s*:\\s*["'])([^"']+)(["'])`, "gi");

/** Defensive output scrubber. Flywheel remains the primary credential boundary. */
export function redactSensitiveText(input: string): string {
  return input
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(SECRET_JSON, "$1[redacted]$3")
    .replace(SECRET_ASSIGNMENT, "$1=[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
}

/**
 * Direct sandbox commands must not become a side channel around Flywheel's
 * credential broker. This intentionally catches common explicit secret forms;
 * it is not represented as a vault or a complete DLP system.
 */
export function assertCredentialFreeCommand(command: string[]): void {
  for (let index = 0; index < command.length; index++) {
    const part = command[index] ?? "";
    const previous = command[index - 1] ?? "";
    if (
      SECRET_ASSIGNMENT.test(part) ||
      /\bAuthorization\s*:\s*Bearer\b/i.test(part) ||
      (/^--?[a-z0-9_-]+$/i.test(previous) && SECRET_TERM.test(previous))
    ) {
      SECRET_ASSIGNMENT.lastIndex = 0;
      throw new Error(
        "Credential-like command arguments are refused. Bind a Flywheel credential profile instead of passing secrets to the guest.",
      );
    }
    SECRET_ASSIGNMENT.lastIndex = 0;
    try {
      const url = new URL(part);
      if (url.username || url.password) {
        throw new Error(
          "Credential-bearing URLs are refused. Bind a Flywheel credential profile instead.",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Credential-bearing")) throw error;
    }
  }
}
