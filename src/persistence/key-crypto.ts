/**
 * API-key encryption at rest.
 *
 * Stored provider keys (the `api_keys` table) are sensitive. This module is the
 * single place that decides whether key-at-rest encryption is active and (later)
 * performs the encrypt/decrypt. Until encryption is wired, keys are stored in
 * plaintext and this reports `false` so the Admin → Security panel tells the
 * truth instead of implying a non-existent toggle.
 */

/** True when key-at-rest encryption is configured and active. */
export function isKeyEncryptionEnabled(): boolean {
  return false;
}
