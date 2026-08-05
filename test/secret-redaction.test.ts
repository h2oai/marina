import { describe, expect, test } from "bun:test";
import { assertCredentialFreeCommand, redactSensitiveText } from "../src/security/secret-redaction";

describe("sandbox secret boundary", () => {
  test("redacts common credential forms before remote output persistence", () => {
    const redacted = redactSensitiveText(
      'Authorization: Bearer abc123 API_KEY=sk-live "access_token":"token-value" https://u:p@example.com',
    );
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("sk-live");
    expect(redacted).not.toContain("token-value");
    expect(redacted).not.toContain("u:p");
    expect(redacted).toContain("[redacted]");
  });

  test("refuses direct secret arguments while permitting ordinary commands", () => {
    expect(() => assertCredentialFreeCommand(["bun", "test"])).not.toThrow();
    expect(() => assertCredentialFreeCommand(["env", "OPENAI_API_KEY=secret"])).toThrow(
      "credential profile",
    );
    expect(() => assertCredentialFreeCommand(["curl", "--token", "secret"])).toThrow(
      "credential profile",
    );
    expect(() =>
      assertCredentialFreeCommand(["git", "clone", "https://u:p@example.com/x"]),
    ).toThrow("Credential-bearing URLs");
  });
});
