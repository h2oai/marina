// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  VERIFICATION_TONE_CLASS,
  verificationLabel,
  verificationOutcomeFromStatus,
  verificationTone,
} from "../lib/verification-outcome";

describe("verification outcome presentation", () => {
  it("never shows not_run or error as a pass or a failure", () => {
    expect(verificationTone("passed")).toBe("success");
    expect(verificationTone("failed")).toBe("danger");
    expect(verificationTone("not_run")).toBe("muted");
    expect(verificationTone("error")).toBe("warning");
    expect(VERIFICATION_TONE_CLASS[verificationTone("not_run")]).not.toBe(
      VERIFICATION_TONE_CLASS[verificationTone("failed")],
    );
  });

  it("labels outcomes and maps stored artifact statuses", () => {
    expect(verificationLabel("not_run")).toBe("not run");
    expect(verificationLabel(undefined)).toBe("not recorded");
    expect(verificationLabel(undefined, "not yet submitted")).toBe("not yet submitted");
    expect(verificationLabel("stale")).toBe("stale");
    expect(verificationOutcomeFromStatus("complete")).toBe("passed");
    expect(verificationOutcomeFromStatus("not_run")).toBe("not_run");
    expect(verificationOutcomeFromStatus("running")).toBeUndefined();
  });
});
