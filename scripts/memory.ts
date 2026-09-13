// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getErrorMessage } from "../src/engine/errors";
import { ollamaEmbeddings } from "../src/memory/embeddings";
import { localEmbeddings } from "../src/memory/local-embeddings";
import { serveMemory } from "../src/memory/server";
import { MarinaDB } from "../src/persistence/database";
import { rotateMemoryBackups } from "../src/persistence/db-memory-backups";
import { snapshotMemoryDatabase } from "../src/persistence/db-memory-maintenance";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import type { MemoryTransferFilter } from "../src/sdk/memory-transfer";
import { resumeMemoryTransfer } from "../src/sdk/memory-transfer-client";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    db: { type: "string", default: "data/memory.db" },
    name: { type: "string" },
    credentials: { type: "string" },
    url: { type: "string", default: "http://127.0.0.1:3301" },
    space: { type: "string" },
    transfer: { type: "string" },
    state: { type: "string" },
    expired: { type: "boolean" },
    cursor: { type: "string" },
    "source-url": { type: "string" },
    "source-credentials": { type: "string" },
    port: { type: "string", default: "3301" },
    host: { type: "string", default: "127.0.0.1" },
    embeddings: { type: "string", default: "none" },
    "model-cache": { type: "string", default: "data/memory-models" },
    "local-only": { type: "boolean", default: false },
    "embedding-url": { type: "string" },
    "embedding-model": { type: "string" },
    "embedding-revision": { type: "string" },
    credential: { type: "string" },
    output: { type: "string" },
    backup: { type: "string" },
    before: { type: "string" },
    limit: { type: "string" },
    apply: { type: "boolean", default: false },
    directory: { type: "string" },
    keep: { type: "string", default: "7" },
  },
});

try {
  const dbPath = resolve(values.db);
  const command = positionals[0];
  if (command?.startsWith("transfer-")) {
    if (!values.credentials)
      throw new Error("Supply --credentials for the destination memory service");
    const identity = JSON.parse(readFileSync(values.credentials, "utf8"));
    const space = values.space ?? identity.spaceId;
    if (typeof identity.token !== "string" || typeof space !== "string")
      throw new Error("Invalid destination credentials or space");
    const client = new MarinaMemoryClient(values.url, identity.token, 130000);
    let result: unknown;
    if (command === "transfer-list") {
      result = await client.transfers(space, {
        state: values.state as MemoryTransferFilter["state"],
        expired: values.expired,
        cursor: values.cursor,
        limit: Number(values.limit ?? 20),
      });
    } else {
      if (!values.transfer)
        throw new Error("Supply --transfer ID; use transfer-list to discover IDs");
      if (command === "transfer-status")
        result = await client.transferStatus(space, values.transfer);
      else if (command === "transfer-abort")
        result = await client.abortTransfer(space, values.transfer, `${values.transfer}:abort`);
      else if (command === "transfer-resume") {
        let source: MarinaMemoryClient | undefined;
        if (values["source-credentials"] || values["source-url"]) {
          if (!values["source-credentials"] || !values["source-url"])
            throw new Error("Supply both --source-url and --source-credentials");
          const identity = JSON.parse(readFileSync(values["source-credentials"], "utf8"));
          if (typeof identity.token !== "string") throw new Error("Invalid source credentials");
          source = new MarinaMemoryClient(values["source-url"], identity.token);
        }
        result = await resumeMemoryTransfer(client, space, values.transfer, { source });
      } else
        throw new Error("Use transfer-list, transfer-status, transfer-resume or transfer-abort");
    }
    console.log(JSON.stringify(result));
  } else if (command === "rotate-backups") {
    if (!values.directory) throw new Error("rotate-backups requires --directory");
    console.log(
      JSON.stringify(await rotateMemoryBackups(dbPath, values.directory, Number(values.keep))),
    );
  } else if (command === "compact-receipts") {
    if (!values.before)
      throw new Error(
        "compact-receipts requires --before UTC_MILLISECONDS; preview first, then --apply",
      );
    const db = new MarinaDB(dbPath, { durability: "full" });
    try {
      console.log(
        JSON.stringify(
          db.compactMemoryReceipts({
            before: Number(values.before),
            limit: Number(values.limit ?? 1000),
            apply: values.apply,
          }),
        ),
      );
    } finally {
      db.close();
    }
  } else if (command === "backup" || command === "restore") {
    const source = command === "backup" ? dbPath : values.backup;
    const target = command === "backup" ? values.output : dbPath;
    if (!source || !target)
      throw new Error("backup requires --output; restore requires --backup and a new --db path");
    console.log(JSON.stringify(await snapshotMemoryDatabase(source, target)));
  } else if (command === "init") {
    if (!values.name) throw new Error("--name is required");
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    const db = new MarinaDB(dbPath, { durability: "full" });
    try {
      chmodSync(dbPath, 0o600);
      const principal = db.ensurePrincipal({ type: "service", displayName: values.name });
      const credential = db.issueMemoryCredential(principal.principal_id);
      const actor = db.verifyMemoryCredential(credential.token)!;
      const repository = db.memoryRepository();
      const existing = repository
        .spaces(actor)
        .find((space) => space.owner_id === actor.principalId && space.name === "private");
      const space =
        existing?.id ?? repository.createSpace(actor, "private", crypto.randomUUID()).id;
      const result = { ...credential, spaceId: space, dbPath };
      if (values.credentials) {
        writeFileSync(values.credentials, `${JSON.stringify(result, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        console.log(
          JSON.stringify({
            principalId: actor.principalId,
            spaceId: space,
            credentials: resolve(values.credentials),
          }),
        );
      } else console.log(JSON.stringify(result, null, 2));
    } finally {
      db.close();
    }
  } else if (command === "revoke") {
    if (!values.credential) throw new Error("--credential is required");
    const db = new MarinaDB(dbPath, { durability: "full" });
    try {
      console.log(JSON.stringify({ revoked: db.revokeWorkloadCredential(values.credential) }));
    } finally {
      db.close();
    }
  } else if (command === "serve") {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid --port");
    if (!["none", "local", "ollama"].includes(values.embeddings))
      throw new Error("--embeddings must be none, local or ollama");
    const embeddings =
      values.embeddings === "local"
        ? await localEmbeddings(resolve(values["model-cache"]), values["local-only"])
        : values.embeddings === "ollama"
          ? ollamaEmbeddings(
              values["embedding-url"] ?? "http://127.0.0.1:11434",
              values["embedding-model"] ?? "",
              values["embedding-revision"] ?? "",
            )
          : undefined;
    const runtime = serveMemory({ dbPath, port, hostname: values.host, embeddings });
    console.log(
      JSON.stringify({
        ready: true,
        url: `http://${values.host}:${runtime.server.port}`,
        capabilities: runtime.service.capabilities(),
      }),
    );
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void runtime.close().then(() => process.exit(0));
    };
    process.on("SIGTERM", close);
    process.on("SIGINT", close);
  } else
    console.log(
      "Usage: bun run memory transfer-list --credentials FILE [--url URL] [--space ID] [--state receiving|ready|committed|aborted] [--expired] [--limit 20] [--cursor ID]\n       bun run memory transfer-status|transfer-abort|transfer-resume --credentials FILE --transfer ID [--url URL] [--source-url URL --source-credentials FILE]\n       bun run memory init --name NAME [--credentials FILE] [--db FILE]\n       bun run memory serve [--db FILE] [--port 3301] [--embeddings none|local|ollama]\n       bun run memory revoke --credential ID [--db FILE]\n       bun run memory backup --db FILE --output NEW_FILE\n       bun run memory restore --backup FILE --db NEW_FILE\n       bun run memory rotate-backups --db FILE --directory DIR [--keep 7]\n       bun run memory compact-receipts --db FILE --before UTC_MS [--limit 1000] [--apply]",
    );
} catch (error) {
  console.error(getErrorMessage(error));
  process.exitCode = 1;
}
