// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Image-provider registry — maps a provider id to its generator so the media
 * manager dispatches uniformly. Resolution order:
 *   1. built-in cloud providers (openai, stability, google)
 *   2. Automatic1111 / SD.Next local WebUI
 *   3. any OpenAI-compatible endpoint configured via `<PROVIDER>_IMAGE_BASE_URL`
 * Local/custom endpoints (2 & 3) are key-OPTIONAL.
 */

import { generateAutomatic1111Image } from "./automatic1111";
import { generateFluxImage } from "./flux";
import { generateGoogleImage } from "./google-image";
import { isAutomatic1111, isLocalImageProvider } from "./image-endpoints";
import type { ImageGenerator } from "./image-util";
import { generateOpenAIImage } from "./openai";
import { generateOpenAICompatibleImage } from "./openai-compatible-image";
import { generateStabilityImage } from "./stability";

const BUILTIN: Record<string, ImageGenerator> = {
  openai: generateOpenAIImage,
  stability: generateStabilityImage,
  google: generateGoogleImage,
  flux: generateFluxImage,
};

/** Image model used when a request names none and the instance default is not an image model. */
export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2";

/**
 * True when `model` is an image-generation model this registry can serve:
 * an OpenAI image id (`gpt-image-*`, `dall-e-*`) or any id on a non-OpenAI
 * image provider (stability, google, flux, a local endpoint).
 */
export function isImageModel(model: string): boolean {
  const slash = model.indexOf("/");
  if (slash <= 0) return false;
  const provider = model.slice(0, slash);
  const id = model.slice(slash + 1);
  if (provider === "openai") return /^(gpt-image-|dall-e)/i.test(id);
  if (provider === "google") return /image|imagen/i.test(id);
  return getImageProvider(provider) !== undefined;
}

/**
 * The image model for a request that names none: the instance default model
 * when it is an image model (Admin → Model), else {@link DEFAULT_IMAGE_MODEL}
 * — never the chat default (that sent `marina/default` or a chat model id to
 * the image API).
 */
export function defaultImageModel(instanceDefault: string | undefined | null): string {
  return instanceDefault && isImageModel(instanceDefault) ? instanceDefault : DEFAULT_IMAGE_MODEL;
}

/** The generator for a provider id, or undefined if unsupported/unconfigured. */
export function getImageProvider(provider: string): ImageGenerator | undefined {
  if (BUILTIN[provider]) return BUILTIN[provider];
  if (isAutomatic1111(provider)) return generateAutomatic1111Image;
  if (isLocalImageProvider(provider)) return generateOpenAICompatibleImage;
  return undefined;
}

/**
 * Whether a key is required up front. Built-in cloud providers need one; local /
 * operator-configured endpoints are key-optional (they read their own env key).
 */
export function imageProviderRequiresKey(provider: string): boolean {
  return provider in BUILTIN;
}

/** Human-readable list of supported image providers, for error messages. */
export function knownImageProviders(): string[] {
  return [...Object.keys(BUILTIN), "automatic1111", "<custom via *_IMAGE_BASE_URL>"];
}
