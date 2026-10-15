// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Short-lived signed asset URLs.
 *
 * `<img>`, `<video>`, `<audio>`, `<iframe>` and `<a download>` cannot send an
 * `Authorization` header, so a remote dashboard viewer could not read the bytes
 * of a private asset (a staged model-API request image) even when the read
 * check allows it. An authenticated client asks `POST /api/assets/sign` for a
 * URL of the form `/assets/<key>?p=<principal>&exp=<unix s>&sig=<hmac>`; the
 * HMAC binds (asset id, principal, exp) under a per-process secret.
 *
 * The signature carries IDENTITY, not access: `/assets/:key` resolves the
 * reader as the signed principal and still runs the normal private-asset check
 * as that principal. An expired, tampered or foreign signature is ignored and
 * the request is read exactly like an anonymous one.
 *
 * The secret is generated per process and never persisted, so every signed URL
 * dies when the server restarts — acceptable for a ten-minute lifetime (the
 * dashboard re-signs on demand).
 */

import { createHmac, randomBytes } from "node:crypto";
import { secretsEqual } from "../../auth/secret-compare";
import { DESKTOP_OPERATOR_ENTITY_ID, OPEN_API_ENTITY_ID } from "../auth-middleware";
import { LOOPBACK_PRINCIPAL } from "../canvas/canvas-principal";

/** Lifetime of a signed asset URL, in seconds. */
export const ASSET_URL_TTL_SECONDS = 600;

/** Most URLs one `POST /api/assets/sign` request may ask for. */
export const MAX_SIGN_BATCH = 100;

let secret: Buffer | undefined;

function key(): Buffer {
  secret ??= randomBytes(32);
  return secret;
}

/** Forget the process secret: every URL signed so far stops verifying (tests). */
export function resetAssetSigningSecretForTests(): void {
  secret = undefined;
}

/**
 * Principals a signature may name: real entities only. The sentinels already
 * read without a header (loopback peer, dev-open) or stand for an operator
 * capability that must never travel as a bearer URL.
 */
export function maySignFor(principal: string | undefined): principal is string {
  return (
    !!principal &&
    principal !== LOOPBACK_PRINCIPAL &&
    principal !== OPEN_API_ENTITY_ID &&
    principal !== DESKTOP_OPERATOR_ENTITY_ID
  );
}

function mac(assetId: string, principal: string, exp: number): string {
  return createHmac("sha256", key())
    .update(`marina-asset-url:v1\0${assetId}\0${principal}\0${exp}`)
    .digest("base64url");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The asset id a storage key addresses (keys are `<asset id><ext>`, see
 * `handleUpload`). Signatures bind the id, so an extension spelled with
 * characters a browser percent-encodes cannot break verification.
 */
export function assetIdFromKey(storageKey: string): string {
  return storageKey.replace(/\.[^./]*$/, "");
}

/** Signature parameters for asset `assetId` read as `principal`. */
export function signAssetId(
  assetId: string,
  principal: string,
  now = nowSeconds(),
): { p: string; exp: number; sig: string } {
  const exp = now + ASSET_URL_TTL_SECONDS;
  return { p: principal, exp, sig: mac(assetId, principal, exp) };
}

/** `url` (the asset's resolved `/assets/<key>` URL) with signature parameters appended. */
export function signedAssetUrl(
  url: string,
  assetId: string,
  principal: string,
  now = nowSeconds(),
): { url: string; expiresAt: number } {
  const { p, exp, sig } = signAssetId(assetId, principal, now);
  const qs = new URLSearchParams({ p, exp: String(exp), sig });
  return { url: `${url}${url.includes("?") ? "&" : "?"}${qs.toString()}`, expiresAt: exp };
}

/**
 * The principal a request's signature names, or undefined when it carries no
 * signature or the signature is expired, malformed, tampered or names a
 * sentinel. `assetId` is the id the request path addresses.
 */
export function verifyAssetSignature(
  assetId: string,
  params: URLSearchParams,
  now = nowSeconds(),
): { principal: string; exp: number } | undefined {
  const principal = params.get("p");
  const expRaw = params.get("exp");
  const sig = params.get("sig");
  if (!principal || !expRaw || !sig || !maySignFor(principal)) return undefined;
  if (!/^\d{1,12}$/.test(expRaw)) return undefined;
  const exp = Number(expRaw);
  if (exp < now || exp > now + ASSET_URL_TTL_SECONDS) return undefined;
  if (!secretsEqual(sig, mac(assetId, principal, exp))) return undefined;
  return { principal, exp };
}

/**
 * The storage key in an `/assets/<key>` path (any query is ignored), else
 * undefined. Only same-server paths are signed; the client strips its own
 * origin before asking.
 */
export function assetKeyFromPath(raw: string): string | undefined {
  const m = /^\/assets\/([^/?#]+)(?:[?#].*)?$/.exec(raw);
  return m?.[1];
}
