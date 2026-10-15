// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Harness decisions over images, on the media side:
 *
 * - `loadDecisionImage` turns an `asset:<id>` / `node:<id>` reference into a
 *   decision image part AS the caller — an asset or canvas node the caller may
 *   not read is "not found", exactly as for `canvas look`.
 * - `verifyGeneratedImage` (`MARINA_MEDIA_VERIFY=off|observe|on`, default
 *   off) asks the world's decision backend whether a freshly generated image
 *   depicts its prompt. `observe` records the verdict (numbers and a label) on
 *   the job and as an `agent_decision` event; `on` also regenerates a
 *   mismatch at most once. Off ⇒ no call and no change. A verifier: an outage
 *   is `unjudged`, never a mismatch, and never regenerates.
 */

import { harnessDecisionProvider } from "../../decisions/engines";
import { maskSensitiveText } from "../../decisions/gate";
import {
  decideMediaVerify,
  type MediaVerifyVerdict,
  mediaVerifyQuestions,
} from "../../decisions/policy";
import type { DecisionImagePart, DecisionProvider } from "../../decisions/types";
import type { MediaJobRow } from "../../persistence/database";
import type { EngineEvent, EntityId } from "../../types";
import { canvasReaderFor } from "../canvas-access";
import type { Engine } from "../engine";
import { getErrorMessage } from "../errors";
import { Logger } from "../logger";
import { probeImage, toDataUrl } from "./image-ops";
import { loadVisualSource } from "./vision";

const log = new Logger();

/** Load `asset:<id>` or `node:<id>` as a decision image part, with the caller's read access. */
export async function loadDecisionImage(
  engine: Engine,
  entityId: EntityId,
  ref: string,
): Promise<DecisionImagePart> {
  if (!/^(?:asset|node):\S+$/.test(ref)) {
    throw new Error(`Image "${ref}": use asset:<id> or node:<id>.`);
  }
  const src = await loadVisualSource(
    engine,
    ref,
    canvasReaderFor(engine, entityId, { inWorld: true }),
  );
  const info = probeImage(src.data);
  if (!info) throw new Error(`"${ref}" is not a PNG, JPEG, WebP or GIF image.`);
  return { type: "image_url", image_url: { url: toDataUrl(src.data, info.mime) } };
}

export type MediaVerifyMode = "off" | "observe" | "on";

/** `MARINA_MEDIA_VERIFY`: `off` (default) | `observe` | `on`; anything else is off. */
export function mediaVerifyMode(env: NodeJS.ProcessEnv = process.env): MediaVerifyMode {
  const v = env.MARINA_MEDIA_VERIFY?.trim().toLowerCase();
  return v === "observe" || v === "on" ? v : "off";
}

/** Job metadata key marking a regeneration (it is never regenerated again). */
export const REGENERATION_OF = "mediaVerifyRegenerationOf";

export interface MediaVerifyHost {
  db: {
    getMediaJob(id: string): MediaJobRow | undefined;
    updateMediaJob(id: string, patch: { metadata: Record<string, unknown> | null }): void;
  };
  logEvent: (event: EngineEvent) => void;
  /** Start ONE regeneration of the same request, its metadata merged with `metadata`. */
  regenerate?: (metadata: Record<string, unknown>) => Promise<unknown>;
  /** Default: the harness decision provider (`MARINA_DECISIONS` / `MARINA_DECISION_ENGINE`). */
  provider?: () => DecisionProvider | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface GeneratedImage {
  jobId: string;
  entityName: string;
  prompt: string;
  data: Uint8Array;
  /** The job's own metadata (a regeneration carries {@link REGENERATION_OF}). */
  metadata?: Record<string, unknown> | null;
}

export interface MediaVerifyOutcome extends MediaVerifyVerdict {
  regenerated: boolean;
  error?: string;
}

const PROMPT_CHARS = 1_000;

/**
 * The media manager's one hook after an image job succeeds: off ⇒ nothing;
 * otherwise the check runs detached (the job's caller never waits on it) and
 * is drained by `engine.shutdown()` when the engine tracks background work.
 */
export function startMediaVerify(
  engine: Pick<Engine, "trackBackground"> | undefined,
  host: MediaVerifyHost,
  image: GeneratedImage,
): void {
  if (mediaVerifyMode(host.env ?? process.env) === "off") return;
  const work = verifyGeneratedImage(host, image).catch((err) => {
    log.warn("media", "Media verify failed", { error: getErrorMessage(err) });
    return undefined;
  });
  if (typeof engine?.trackBackground === "function") void engine.trackBackground(work);
}

/**
 * Check one generated image. Returns undefined (and does nothing) when the
 * mode is off, no decision backend exists, or the bytes are not an image;
 * otherwise the verdict, after it was recorded. Never throws.
 */
export async function verifyGeneratedImage(
  host: MediaVerifyHost,
  image: GeneratedImage,
): Promise<MediaVerifyOutcome | undefined> {
  const env = host.env ?? process.env;
  const mode = mediaVerifyMode(env);
  if (mode === "off") return undefined;
  const info = probeImage(image.data);
  if (!info) return undefined;
  let provider: DecisionProvider | undefined;
  try {
    provider = host.provider ? host.provider() : harnessDecisionProvider(env);
  } catch (err) {
    log.warn("media", "Media verify: no decision provider", { error: getErrorMessage(err) });
  }
  if (!provider) return undefined;

  let verdict: MediaVerifyVerdict;
  let meta: {
    provider?: string;
    model?: string;
    latencyMs?: number;
    costUsd?: number;
    error?: string;
  };
  try {
    // The decision provider prepares the image to its limits (or refuses it).
    const result = await provider.ask({
      state: [
        "An image generated for the request below.",
        { type: "image_url", image_url: { url: toDataUrl(image.data, info.mime) } },
      ],
      questions: mediaVerifyQuestions(maskSensitiveText(image.prompt, PROMPT_CHARS)),
    });
    verdict = decideMediaVerify(
      result.answers,
      (result.calibrated ?? provider.calibrated) !== false,
    );
    meta = {
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    };
  } catch (err) {
    verdict = decideMediaVerify(undefined, false);
    meta = { provider: provider.kind, model: provider.model, error: getErrorMessage(err) };
  }

  // `on`: one regeneration of a mismatch, never of a regeneration, never on an outage.
  const regenerate =
    mode === "on" &&
    verdict.label === "mismatch" &&
    !!host.regenerate &&
    !image.metadata?.[REGENERATION_OF];

  // Numbers and labels only — never the prompt or the image.
  const record = (extra: Record<string, unknown>) => {
    try {
      const row = host.db.getMediaJob(image.jobId);
      const previous = row?.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
      const prior = (previous.mediaVerify ?? {}) as Record<string, unknown>;
      host.db.updateMediaJob(image.jobId, {
        metadata: { ...previous, mediaVerify: { ...prior, ...extra } },
      });
    } catch (err) {
      log.warn("media", "Media verify verdict not recorded", { error: getErrorMessage(err) });
    }
  };
  record({
    mode,
    label: verdict.label,
    signals: verdict.signals,
    ...(meta.model ? { model: meta.model } : {}),
    at: Date.now(),
  });
  host.logEvent({
    type: "agent_decision",
    name: image.entityName,
    stage: "media_verify",
    subject: `media:${image.jobId}`,
    verdict: verdict.label,
    reason:
      verdict.label === "unjudged"
        ? "judge unavailable"
        : `${mode}${regenerate ? ", regenerating once" : ""}`,
    signals: verdict.signals,
    ...meta,
    timestamp: Date.now(),
  });

  let regenerated = false;
  let regenerateError: string | undefined;
  if (regenerate) {
    try {
      // The regeneration is an ordinary job: quota, spend cap and moderation apply.
      await host.regenerate!({ [REGENERATION_OF]: image.jobId });
      regenerated = true;
      record({ regenerated: true });
    } catch (err) {
      regenerateError = getErrorMessage(err);
      record({ regenerated: false, regenerateError });
    }
  }
  return {
    ...verdict,
    regenerated,
    ...(meta.error ? { error: meta.error } : regenerateError ? { error: regenerateError } : {}),
  };
}
