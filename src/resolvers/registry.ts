// Module-level resolver registry. Mirrors the command registry pattern.
// Resolvers register at engine boot via registerBuiltinResolvers(); tests can
// clearResolvers() between cases.

import type { Resolver } from "./types";

const REGISTRY = new Map<string, Resolver<unknown>>();

export function registerResolver<A>(r: Resolver<A>): void {
  if (REGISTRY.has(r.kind)) {
    throw new Error(`Resolver kind already registered: ${r.kind}`);
  }
  REGISTRY.set(r.kind, r as Resolver<unknown>);
}

export function getResolver(kind: string): Resolver<unknown> | undefined {
  return REGISTRY.get(kind);
}

export function listResolvers(): Resolver<unknown>[] {
  return [...REGISTRY.values()];
}

/** Test helper — clears all registrations. Not exported to production code. */
export function clearResolvers(): void {
  REGISTRY.clear();
}
