// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { type MarinaMemoryClient, MemoryClientError } from "./memory-client";
import { retryMemoryOperation } from "./memory-retry";
import type { MemoryTransferStatus } from "./memory-transfer";

/** Move pages outside model context; durable status and stable request keys survive restarts. */
export async function resumeMemoryTransfer(
  destination: MarinaMemoryClient,
  space: string,
  id: string,
  options: {
    source?: MarinaMemoryClient;
    signal?: AbortSignal;
    progress?: (status: MemoryTransferStatus) => void;
  } = {},
) {
  const target = options.signal ? destination.withSignal(options.signal) : destination;
  const source = options.signal ? options.source?.withSignal(options.signal) : options.source;
  let status = await target.transferStatus(space, id);
  for (;;) {
    options.signal?.throwIfAborted();
    options.progress?.(status);
    if (status.state === "committed") return status;
    if (status.state === "aborted" || status.expires_at <= Date.now())
      throw new MemoryClientError(
        409,
        "transfer_inactive",
        "Transfer was aborted or expired; inspect or explicitly abort staging",
      );
    if (status.state === "ready") {
      await retryMemoryOperation(
        () => target.commitTransfer(space, id, status.sha256, `${id}:commit`),
        { signal: options.signal },
      );
      status = await target.transferStatus(space, id);
      continue;
    }
    if (!source)
      throw new MemoryClientError(
        400,
        "source_required",
        "Supply the original source client to resume pages",
      );
    const page = await retryMemoryOperation(
      () => source.exportTransferPage(status.header.origin_space, status.next_cursor ?? undefined),
      { signal: options.signal },
    );
    const expected = status.position;
    status = await retryMemoryOperation(
      () => target.appendTransfer(space, id, page, `${id}:page:${expected}`),
      { signal: options.signal },
    );
    if (status.state === "receiving" && status.position <= expected)
      throw new MemoryClientError(
        502,
        "invalid_transfer",
        "Source page did not advance the transfer",
      );
  }
}
