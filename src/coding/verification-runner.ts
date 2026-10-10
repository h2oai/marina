// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from "node:fs";
import { withoutCommandResponse } from "../engine/command-response";
import { getErrorMessage } from "../engine/errors";
import type { CodingArtifactRow, MarinaDB } from "../persistence/database";

const MAX_BACKGROUND_VERIFICATIONS = 4;
const MAX_VERIFICATION_COMMANDS = 8;

export function assertBoundedVerification(commands: readonly string[]): void {
  if (commands.length === 0 || commands.length > MAX_VERIFICATION_COMMANDS)
    throw new Error(
      `Background verification requires between 1 and ${MAX_VERIFICATION_COMMANDS} finite commands.`,
    );
}

/** Engine-owned finite checks, recorded in the existing artifact ledger. No work queue:
 * admission either reserves capacity now or refuses without starting a process. */
export class VerificationRunner {
  private readonly roots = new Set<string>();

  constructor(
    private readonly db: MarinaDB,
    private readonly track: (pending: Promise<void>) => void,
  ) {}

  start(input: {
    sessionId: string;
    actor: string;
    root: string;
    commands: string[];
    execute: (receiptId: string) => Promise<CodingArtifactRow>;
    notify: (receipt: CodingArtifactRow) => void | Promise<void>;
  }): CodingArtifactRow {
    const root = realpathSync(input.root);
    if (this.roots.has(root))
      throw new Error("Background verification is already running in this workspace.");
    if (this.roots.size >= MAX_BACKGROUND_VERIFICATIONS)
      throw new Error(
        `Background verification capacity reached (${MAX_BACKGROUND_VERIFICATIONS}). Retry after a check finishes.`,
      );
    assertBoundedVerification(input.commands);
    const receipt = this.db.createCodingArtifact({
      sessionId: input.sessionId,
      createdBy: input.actor,
      kind: "verification_request",
      title: "Background verification",
      status: "running",
      contentText: input.commands.join("\n"),
      metadata: { commands: input.commands, workspace: root },
    });
    this.roots.add(root);
    const metadata = JSON.parse(receipt.metadata_json) as Record<string, unknown>;
    // Leave request correlation before creating the promise: completion is a later world event.
    // The codingRunContext stays intact, including an explicitly absent task attempt.
    const pending = withoutCommandResponse(async () => {
      await Promise.resolve();
      try {
        const result = await input.execute(receipt.id);
        this.db.updateCodingArtifact(receipt.id, {
          status: result.status,
          metadata: { ...metadata, resultArtifactId: result.id },
        });
      } catch (error) {
        this.db.updateCodingArtifact(receipt.id, {
          status: "error",
          metadata: {
            ...metadata,
            error: getErrorMessage(error),
            outcomeReason: getErrorMessage(error),
          },
        });
      } finally {
        this.roots.delete(root);
      }
      await input.notify(this.db.getCodingArtifact(receipt.id)!);
    });
    this.track(pending);
    return receipt;
  }
}
