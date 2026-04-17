/**
 * Named-context registry, mirroring harnessless's NAME parameter.
 *
 * No supervisor, no retry, no reconnect — just a map. The LLM can only use
 * one context at a time per task; "default" is the common case.
 */

import { createContext, type CreateContextOptions, type HlContext } from './context';
import { mainLogger } from '../logger';

const contexts = new Map<string, HlContext>();

export async function getOrCreate(name: string, opts: CreateContextOptions): Promise<HlContext> {
  const existing = contexts.get(name);
  if (existing) return existing;
  const ctx = await createContext({ ...opts, name });
  contexts.set(name, ctx);
  mainLogger.info('hl.runtime.create', { name, transport: ctx.cdp.transport });
  return ctx;
}

export function get(name: string): HlContext | null {
  return contexts.get(name) ?? null;
}

export async function destroy(name: string): Promise<void> {
  const ctx = contexts.get(name);
  if (!ctx) return;
  await ctx.cdp.close();
  contexts.delete(name);
  mainLogger.info('hl.runtime.destroy', { name });
}

export async function destroyAll(): Promise<void> {
  for (const name of Array.from(contexts.keys())) await destroy(name);
}
