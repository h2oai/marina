/**
 * Configurable image endpoints — lets operators use *any* image model, hosted or
 * local, without a code change. Two shapes:
 *
 *  - **Automatic1111 / SD.Next** (local WebUI): provider `automatic1111` (aliases
 *    `a1111`, `sd`, `sdnext`). Base URL from `A1111_BASE_URL`
 *    (default http://localhost:7860); optional `A1111_API_KEY`.
 *  - **Any OpenAI-compatible image server** (Together, Fireworks, DeepInfra,
 *    LocalAI, vLLM, …): set `<PROVIDER>_IMAGE_BASE_URL` (+ optional
 *    `<PROVIDER>_API_KEY`) and address models as `<provider>/<model>`.
 *
 * Both paths are key-OPTIONAL (local servers are often keyless), so the media
 * manager doesn't require a key for them.
 */

const A1111_ALIASES = new Set(["automatic1111", "a1111", "sd", "sdnext"]);

/** Normalize a provider id to an env-var prefix (UPPER, non-alnum → `_`). */
function envPrefix(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function isAutomatic1111(provider: string): boolean {
  return A1111_ALIASES.has(provider.toLowerCase());
}

/** Custom OpenAI-compatible image endpoint configured for this provider id? */
function customImageBaseUrl(provider: string): string | undefined {
  return process.env[`${envPrefix(provider)}_IMAGE_BASE_URL`];
}

/** Base URL for a local/custom image provider (trailing slash trimmed), or undefined. */
export function imageEndpointBaseUrl(provider: string): string | undefined {
  const raw = isAutomatic1111(provider)
    ? (process.env.A1111_BASE_URL ?? process.env.AUTOMATIC1111_BASE_URL ?? "http://localhost:7860")
    : customImageBaseUrl(provider);
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

/** Optional bearer key for a local/custom image provider. */
export function imageEndpointKey(provider: string): string | undefined {
  if (isAutomatic1111(provider)) return process.env.A1111_API_KEY;
  return process.env[`${envPrefix(provider)}_API_KEY`];
}

/**
 * True for a self-hosted / operator-configured image endpoint (Automatic1111, or
 * any provider with a `<PROVIDER>_IMAGE_BASE_URL`). These are key-optional.
 */
export function isLocalImageProvider(provider: string): boolean {
  return isAutomatic1111(provider) || customImageBaseUrl(provider) !== undefined;
}
