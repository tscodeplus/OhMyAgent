/**
 * Process-wide JudgeEngine lookup.
 *
 * The engine is built in `src/app/bootstrap.ts` after (and possibly rebuilt on
 * config hot-reload independently of) the services that need it — memory
 * services, the context transform, and the approval path cannot take a
 * constructor-time instance. They instead hold this module-level resolver,
 * which bootstrap keeps pointed at the live engine. When the engine is absent
 * (`judge.enabled` false / no resolvable judge) every hook point sees
 * `undefined` and is a strict no-op — identical to the pre-judge behavior.
 */

import type { JudgeEngine } from './engine.js';

let resolveEngine: () => JudgeEngine | undefined = () => undefined;

export function setJudgeEngineResolver(resolve: () => JudgeEngine | undefined): void {
  resolveEngine = resolve;
}

/** The live engine, or undefined when the judge kernel is inactive. Never throws. */
export function currentJudgeEngine(): JudgeEngine | undefined {
  try {
    return resolveEngine();
  } catch {
    return undefined;
  }
}
