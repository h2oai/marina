// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Engine } from "../engine/engine";
import { SAFETY_GATES } from "../engine/safety-gates";
import { registerResolver, unregisterResolver } from "../resolvers/registry";
import type { Resolver } from "../resolvers/types";
import type { ExtensionContext, ExtensionWidget, MarinaExtension } from "../sdk/extensions";

const widgets = new WeakMap<Engine, ExtensionWidget[]>();
export function extensionWidgets(engine: Engine): readonly ExtensionWidget[] {
  return widgets.get(engine) ?? [];
}

/** Explicit directory allowlist; no installation, network resolution or implicit code scan. */
export type ExtensionShutdown = (() => Promise<void>) & { beginDrain(): void };

export async function loadExtensions(
  engine: Engine,
  directories: string[],
): Promise<ExtensionShutdown> {
  const cleanup: Array<() => Promise<void>> = [];
  const drain: Array<() => void> = [];
  const names = new Set<string>();
  widgets.set(engine, []);
  try {
    for (const directory of directories) {
      const root = realpathSync(resolve(directory));
      const manifest = JSON.parse(readFileSync(resolve(root, "marina-plugin.json"), "utf8")) as {
        name: string;
        version: string;
        apiVersion: number;
        entry: string;
      };
      if (
        typeof manifest.name !== "string" ||
        !/^[a-z][a-z0-9-]*$/.test(manifest.name) ||
        !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version) ||
        manifest.apiVersion !== 1 ||
        typeof manifest.entry !== "string" ||
        names.has(manifest.name)
      )
        throw new Error(`Invalid or incompatible extension manifest: ${directory}`);
      names.add(manifest.name);
      const entry = realpathSync(resolve(root, manifest.entry));
      const rel = relative(root, entry);
      if (isAbsolute(rel) || rel.startsWith(".."))
        throw new Error("Extension entry must be inside its directory");
      const owner = `extension:${manifest.name}`;
      const controller = new AbortController();
      const resolvers: Resolver<unknown>[] = [];
      const ownedWidgets: ExtensionWidget[] = [];
      let deactivate: void | (() => void | Promise<void>);
      let active = true;
      let disposed = false;
      drain.push(() => {
        active = false;
        controller.abort();
      });
      const checkActive = () => {
        if (!active) throw new Error("Extension has been stopped");
      };
      cleanup.push(async () => {
        if (disposed) return;
        disposed = true;
        active = false;
        controller.abort();
        try {
          await deactivate?.();
        } finally {
          engine.commands.removeOwner(owner);
          for (const resolver of resolvers) unregisterResolver(resolver);
          widgets.set(
            engine,
            (widgets.get(engine) ?? []).filter((widget) => !ownedWidgets.includes(widget)),
          );
        }
      });
      const context = Object.freeze<ExtensionContext>({
        apiVersion: 1 as const,
        signal: controller.signal,
        registerCommand(command) {
          checkActive();
          if (
            typeof command.run !== "function" ||
            !Number.isInteger(command.minRank) ||
            command.minRank < 0 ||
            command.minRank > 9 ||
            (command.gate && !Object.hasOwn(SAFETY_GATES, command.gate))
          )
            throw new Error("Invalid command permissions");
          engine.commands.registerOwned(owner, {
            name: command.name,
            aliases: command.aliases,
            help: command.help,
            minRank: command.minRank,
            gate: command.gate,
            category: "Extensions",
            handler: async (room, input) => {
              const entity = room.getEntity(input.entity);
              if (!entity) return;
              await command.run(
                Object.freeze({
                  caller: Object.freeze({
                    id: entity.id,
                    name: entity.name,
                    rank: Number(entity.properties.rank ?? 0),
                  }),
                  room: input.room,
                  reply: (message: string) => room.send(input.entity, message),
                }),
                input.args,
              );
            },
          });
        },
        registerResolver(resolver) {
          checkActive();
          if (
            typeof resolver.kind !== "string" ||
            !/^[a-z][a-z0-9-]*$/.test(resolver.kind) ||
            typeof resolver.resolve !== "function" ||
            typeof resolver.parseArgs !== "function" ||
            typeof resolver.idFromArgs !== "function" ||
            !Array.isArray(resolver.closesOn) ||
            resolver.closesOn.some(
              (status) => !["resolved", "changed", "no-change", "error"].includes(status),
            )
          )
            throw new Error("Invalid resolver");
          const wrapped: Resolver<unknown> = {
            ...resolver,
            resolve: ({ args, previousSample }) => resolver.resolve({ args, previousSample }),
          };
          registerResolver(wrapped);
          resolvers.push(wrapped);
        },
        registerWidget(widget) {
          checkActive();
          if (
            typeof widget.id !== "string" ||
            !/^[a-z][a-z0-9-]*$/.test(widget.id) ||
            typeof widget.title !== "string" ||
            !widget.title ||
            widget.title.length > 100 ||
            !["sidebar", "admin-tab"].includes(widget.slot) ||
            !["readiness", "world"].includes(widget.source)
          )
            throw new Error("Invalid widget");
          const owned = Object.freeze({ ...widget, id: `${manifest.name}:${widget.id}` });
          if (widgets.get(engine)!.some((w) => w.id === owned.id))
            throw new Error("Duplicate widget");
          ownedWidgets.push(owned);
          widgets.get(engine)!.push(owned);
        },
      });
      const module = (await import(pathToFileURL(entry).href)) as { default: MarinaExtension };
      if (typeof module.default?.activate !== "function")
        throw new Error("Extension must export activate(context)");
      deactivate = await module.default.activate(context);
      if (deactivate !== undefined && typeof deactivate !== "function")
        throw new Error("Extension activation must return a cleanup function or undefined");
    }
  } catch (error) {
    await Promise.allSettled(cleanup.reverse().map((close) => close()));
    throw error;
  }
  const shutdown = async () => {
    const results = await Promise.allSettled(cleanup.reverse().map((close) => close()));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  shutdown.beginDrain = () => {
    for (const stop of drain) stop();
  };
  return shutdown;
}
