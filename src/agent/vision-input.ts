// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether an agent sees images with its OWN model (`native`) or through a
 * second model's text description (`describe`).
 *
 * `MARINA_AGENT_VISION=native|describe|auto` (default `auto`): `auto` views
 * natively when the agent's model accepts image input, else describes, so a
 * text-only model (one local model, no vision) keeps the description path
 * unchanged. Image INPUT is a model property, separate from image GENERATION
 * (a provider capability, `src/agent/tools/profiles.ts`).
 *
 * Input support is read from, in order: the agent's explicit
 * `supports.imageInput`; the resolved pi-ai model's `input` list (bundled
 * registry, hosted-catalog refresh); for Marina's own proxy model
 * (`marina/default`), the concrete upstream it routes to right now
 * (`describeDefaultUpstream`, registered by the engine at boot). Anything
 * unknown (a local runtime, a remote Marina, an unlisted id) is text-only.
 */

import { inferModelCapabilities } from "../net/model/model-discovery";
import type { AgentSupports } from "./agent-types";
import { hostedModel } from "./hosted-model";
import { piModels } from "./pi-models";

export type AgentVisionPolicy = "native" | "describe" | "auto";

/** `MARINA_AGENT_VISION` → policy; unset/invalid = `auto`. */
export function agentVisionPolicy(env: NodeJS.ProcessEnv = process.env): AgentVisionPolicy {
  const raw = (env.MARINA_AGENT_VISION ?? "").trim().toLowerCase();
  return raw === "native" || raw === "describe" ? raw : "auto";
}

/** The mode a look takes for this policy and model. */
export function agentVisionMode(
  policy: AgentVisionPolicy,
  acceptsImageInput: boolean,
): "native" | "describe" {
  if (policy === "auto") return acceptsImageInput ? "native" : "describe";
  return policy;
}

let defaultUpstream: (() => string | undefined) | undefined;

/** The engine registers what `marina/default` routes to (undefined = unknown). */
export function setDefaultUpstreamDescriber(fn: (() => string | undefined) | undefined): void {
  defaultUpstream = fn;
}

function splitModel(model: string): { provider: string; id: string; remote: boolean } {
  const at = model.indexOf("@");
  const head = at >= 0 ? model.slice(0, at) : model;
  const slash = head.indexOf("/");
  return {
    provider: slash >= 0 ? head.slice(0, slash) : head,
    id: slash >= 0 ? head.slice(slash + 1) : "",
    remote: at >= 0,
  };
}

/** Image input for a concrete `<provider>/<id>`, from the registries Marina already carries. */
function concreteAcceptsImages(model: string): boolean {
  const { provider, id } = splitModel(model);
  if (!id) return false;
  const known = (() => {
    try {
      return piModels.getModel(provider as never, id as never) as { input?: string[] } | undefined;
    } catch {
      return undefined;
    }
  })();
  if (known?.input) return known.input.includes("image");
  const hosted = hostedModel(provider, id);
  if (hosted) return hosted.input.includes("image");
  return inferModelCapabilities(model).imageInput === true;
}

/**
 * Whether `model` reads images. `resolvedInput` is the live pi-ai model's
 * `input` list when the caller has one (a hosted model refreshed from its
 * catalog); Marina's proxy model is judged by its current upstream.
 */
export function modelAcceptsImageInput(
  model: string | undefined,
  resolvedInput?: readonly string[],
): boolean {
  if (!model) return false;
  const { provider, id, remote } = splitModel(model);
  if (provider === "marina") {
    if (remote || (id && id !== "default")) return false;
    const upstream = defaultUpstream?.();
    return upstream ? concreteAcceptsImages(upstream) : false;
  }
  if (resolvedInput?.includes("image")) return true;
  return concreteAcceptsImages(model);
}

/** Explicit configuration first, then the model. */
export function agentAcceptsImageInput(
  supports: AgentSupports | undefined,
  model: string | undefined,
  resolvedInput?: readonly string[],
): boolean {
  if (typeof supports?.imageInput === "boolean") return supports.imageInput;
  return modelAcceptsImageInput(model, resolvedInput);
}
