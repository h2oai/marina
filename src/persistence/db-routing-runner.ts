// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { chmodSync, closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import type { RuntimeState } from "../sdk/routing-runtime-types";
import type { RoutingEventInput, RoutingMessage, RoutingSession } from "../sdk/routing-types";

/** Private local delivery journal, separate from Marina's world database. Never stores credentials. */
export class RoutingRunnerJournal {
  private db: Database;
  private lock: number;
  private bytes = 0;
  private frozenThrough = 0;
  constructor(private readonly path: string) {
    // Deliberately refuse stale locks instead of guessing whether an old supervisor still owns processes.
    this.lock = openSync(`${path}.lock`, "wx", 0o600);
    writeFileSync(this.lock, String(process.pid));
    try {
      this.db = new Database(path, { create: true });
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, session TEXT NOT NULL, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, event TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0);
      `);
      this.bytes = this.db
        .query<{ bytes: number }, []>(
          "SELECT COALESCE(SUM(length(CAST(event AS BLOB))),0) AS bytes FROM outbox",
        )
        .get()!.bytes;
      this.frozenThrough = this.db
        .query<{ sequence: number }, []>("SELECT COALESCE(MAX(sequence),0) AS sequence FROM outbox")
        .get()!.sequence;
    } catch (error) {
      closeSync(this.lock);
      unlinkSync(`${path}.lock`);
      throw error;
    }
  }
  identity(binding: string): string {
    const old = this.db
      .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key=?")
      .get("binding");
    if (old && old.value !== binding)
      throw new Error(
        "Runner journal belongs to another server, account or root; choose another state directory",
      );
    this.db.query("INSERT OR IGNORE INTO settings VALUES ('binding', ?)").run(binding);
    this.db.query("INSERT OR IGNORE INTO settings VALUES ('id', ?)").run(crypto.randomUUID());
    return this.db.query<{ value: string }, []>("SELECT value FROM settings WHERE key='id'").get()!
      .value;
  }
  save(session: RoutingSession, state: RuntimeState) {
    this.db
      .query(
        "INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET session=excluded.session,state=excluded.state",
      )
      .run(session.id, JSON.stringify(session), JSON.stringify(state));
  }
  sessions(): { session: RoutingSession; state: RuntimeState }[] {
    return this.db
      .query<{ session: string; state: string }, []>("SELECT session,state FROM sessions")
      .all()
      .map((row) => ({ session: JSON.parse(row.session), state: JSON.parse(row.state) }));
  }
  enqueue(sessionId: string, event: RoutingEventInput) {
    const value = JSON.stringify(event);
    if (this.bytes + Buffer.byteLength(value) > 268_435_456)
      throw new Error("Output journal reached 256 MiB; reconnect before launching more work");
    // Coalesce token deltas only before their first send. Frozen IDs never change
    // after an ambiguous HTTP response, including across a supervisor restart.
    if (
      event.kind === "output" &&
      event.payload &&
      typeof event.payload === "object" &&
      "text" in event.payload &&
      typeof event.payload.text === "string"
    ) {
      const last = this.db
        .query<{ sequence: number; event: string }, [string, number]>(
          "SELECT sequence,event FROM outbox WHERE session_id=? AND sequence>? ORDER BY sequence DESC LIMIT 1",
        )
        .get(sessionId, this.frozenThrough);
      if (last) {
        const previous = JSON.parse(last.event) as RoutingEventInput;
        const { text, ...metadata } = event.payload;
        const old = previous.payload as { text?: unknown };
        if (previous.kind === "output" && old && typeof old.text === "string") {
          const { text: priorText, ...priorMetadata } = old;
          if (JSON.stringify(metadata) === JSON.stringify(priorMetadata)) {
            const merged = JSON.stringify({
              ...previous,
              payload: { text: priorText + text, ...metadata },
            });
            if (Buffer.byteLength(merged) < 30_000) {
              this.db
                .query("UPDATE outbox SET event=? WHERE sequence=?")
                .run(merged, last.sequence);
              this.bytes += Buffer.byteLength(merged) - Buffer.byteLength(last.event);
              return;
            }
          }
        }
      }
    }
    this.db.query("INSERT INTO outbox(session_id,event) VALUES (?,?)").run(sessionId, value);
    this.bytes += Buffer.byteLength(value);
  }
  batch(): { sequence: number; sessionId: string; event: RoutingEventInput }[] {
    const rows = this.db
      .query<{ sequence: number; session_id: string; event: string }, []>(
        "SELECT sequence,session_id,event FROM outbox ORDER BY sequence LIMIT 100",
      )
      .all();
    let bytes = 0;
    const batch = rows
      .filter((row) => {
        bytes += Buffer.byteLength(row.event) + 256;
        return bytes <= 180_000;
      })
      .map((row) => ({
        sequence: row.sequence,
        sessionId: row.session_id,
        event: JSON.parse(row.event),
      }));
    if (batch.length) this.frozenThrough = batch[batch.length - 1]!.sequence;
    return batch;
  }
  published(sequence: number) {
    const removed = this.db
      .query<{ bytes: number }, [number]>(
        "SELECT COALESCE(SUM(length(CAST(event AS BLOB))),0) AS bytes FROM outbox WHERE sequence<=?",
      )
      .get(sequence)!.bytes;
    this.db.query("DELETE FROM outbox WHERE sequence<=?").run(sequence);
    this.bytes -= removed;
  }
  receipt(message: RoutingMessage, sessionId: string): string | undefined {
    return this.db
      .query<{ status: string }, [string, string]>(
        "SELECT status FROM receipts WHERE id=? AND session_id=?",
      )
      .get(message.id, sessionId)?.status;
  }
  begin(message: RoutingMessage, sessionId: string) {
    this.db
      .query("INSERT INTO receipts(id,session_id,status) VALUES (?,?,'dispatching')")
      .run(message.id, sessionId);
  }
  finish(message: RoutingMessage, status: "accepted" | "rejected" | "uncertain") {
    this.db.query("UPDATE receipts SET status=? WHERE id=?").run(status, message.id);
  }
  acknowledgments(): { sessionId: string; messageId: string }[] {
    return this.db
      .query<{ sessionId: string; messageId: string }, []>(
        "SELECT session_id AS sessionId,id AS messageId FROM receipts WHERE acked=0 AND status!='dispatching' LIMIT 100",
      )
      .all();
  }
  acknowledged(ids: string[]) {
    this.db.transaction(() => {
      for (const id of ids) this.db.query("UPDATE receipts SET acked=1 WHERE id=?").run(id);
    })();
  }
  recover(): { sessionId: string; messageId: string }[] {
    const rows = this.db
      .query<{ sessionId: string; messageId: string }, []>(
        "SELECT session_id AS sessionId,id AS messageId FROM receipts WHERE status='dispatching'",
      )
      .all();
    this.db.query("UPDATE receipts SET status='uncertain' WHERE status='dispatching'").run();
    return rows;
  }
  close() {
    this.db.close();
    closeSync(this.lock);
    unlinkSync(`${this.path}.lock`);
  }
}
