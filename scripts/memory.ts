// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getErrorMessage } from "../src/engine/errors";
import { ollamaEmbeddings } from "../src/memory/embeddings";
import { localEmbeddings } from "../src/memory/local-embeddings";
import { serveMemory } from "../src/memory/server";
import { MarinaDB } from "../src/persistence/database";
import { snapshotMemoryDatabase } from "../src/persistence/db-memory-maintenance";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    db: { type: "string", default: "data/memory.db" },
    name: { type: "string" },
    credentials: { type: "string" },
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
  },
});

try {
  const dbPath = resolve(values.db);
  const command = positionals[0];
  if (command === "backup" || command === "restore") {
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
      "Usage: bun run memory init --name NAME [--credentials FILE] [--db FILE]\n       bun run memory serve [--db FILE] [--port 3301] [--embeddings none|local|ollama]\n       bun run memory revoke --credential ID [--db FILE]\n       bun run memory backup --db FILE --output NEW_FILE\n       bun run memory restore --backup FILE --db NEW_FILE",
    );
} catch (error) {
  console.error(getErrorMessage(error));
  process.exitCode = 1;
}
