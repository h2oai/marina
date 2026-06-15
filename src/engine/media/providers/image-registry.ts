/**
 * Image-provider registry — maps a provider id to its generator so the media
 * manager dispatches uniformly. Add a provider here in one line.
 */

import { generateGoogleImage } from "./google-image";
import type { ImageGenerator } from "./image-util";
import { generateOpenAIImage } from "./openai";
import { generateStabilityImage } from "./stability";

const IMAGE_PROVIDERS: Record<string, ImageGenerator> = {
  openai: generateOpenAIImage,
  stability: generateStabilityImage,
  google: generateGoogleImage,
};

/** The generator for a provider id, or undefined if unsupported. */
export function getImageProvider(provider: string): ImageGenerator | undefined {
  return IMAGE_PROVIDERS[provider];
}

/** Provider ids with image generation support (for error messages / discovery). */
export function knownImageProviders(): string[] {
  return Object.keys(IMAGE_PROVIDERS);
}
