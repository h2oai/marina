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
