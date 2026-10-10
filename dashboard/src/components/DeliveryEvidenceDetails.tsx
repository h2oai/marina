// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Shared, inert presentation of the exact file inventory used by delivery checks. */
export function DeliveryEvidenceDetails({ metadata }: { metadata: Record<string, unknown> }) {
  const delivery = metadata.delivery as
    | {
        manifestPath?: string;
        fingerprint?: string;
        checkedFingerprint?: string;
        files?: { path: string; bytes: number; sha256: string }[];
      }
    | undefined;
  if (!delivery || !Array.isArray(delivery.files)) return null;
  return (
    <section aria-label="Delivery check scope" className="mt-2 space-y-2 text-xs">
      <p>Checks ran with only the listed files in a clean working directory.</p>
      <p className="break-all">Manifest: {delivery.manifestPath}</p>
      {delivery.checkedFingerprint && delivery.checkedFingerprint !== delivery.fingerprint && (
        <p>Checks changed the declared files. This result cannot verify the current delivery.</p>
      )}
      <ul className="space-y-1">
        {delivery.files.map((file) => (
          <li key={file.path} className="break-all">
            {file.path} · {file.bytes} bytes
            <details>
              <summary>Recorded file digest</summary>
              <code>{file.sha256}</code>
            </details>
          </li>
        ))}
      </ul>
      <p>
        Changed files need fresh verification. These checks establish their recorded scope; task
        acceptance still needs review.
      </p>
    </section>
  );
}
