/**
 * Barrel: side-effect-imports every adapter so they self-register, then
 * re-exports the public API for callers in the main process.
 */

// Adapters (side-effect register()):
import './claude-code/adapter';
import './codex/adapter';
import './cursor-agent/adapter';

export { runEngine } from './runEngine';
export { get as getAdapter, list as listAdapters, DEFAULT_ENGINE_ID } from './registry';
export type {
  EngineAdapter,
  InstallProbe,
  AuthProbe,
  RunEngineOptions,
} from './types';
