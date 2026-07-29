import { fail } from '../api/errors.js';
import type { LifecycleModule } from '../core/module.js';
import { progressiveMarket } from './progressive-market/module.js';
import { stagedSurvival } from './staged-survival/module.js';

/**
 * Registry of lifecycle modules shipped in this repository.
 *
 * Modules are in-tree today: a new module lands as `src/modules/<id>/` and adds
 * one line here. `docs/lifecycle-modules.md` records what an out-of-tree plugin
 * boundary would additionally require.
 */
const REGISTRY: readonly LifecycleModule[] = Object.freeze([
  progressiveMarket as unknown as LifecycleModule,
  stagedSurvival as unknown as LifecycleModule,
]);

export function listModules(): readonly LifecycleModule[] {
  return REGISTRY;
}

export function findModule(id: string): LifecycleModule | undefined {
  return REGISTRY.find((module) => module.id === id);
}

export function requireModule(id: string): LifecycleModule {
  const module = findModule(id);
  if (!module) fail('UNKNOWN_MODULE', `No lifecycle module registered for id ${id}`, '$.moduleId');
  return module;
}

export { progressiveMarket, stagedSurvival };
export type { LifecycleModule };
