/**
 * Root barrel.
 *
 * Everything above the `progressive-market` block below is **engine** surface:
 * versions, limits, the error taxonomy, exact rational money, the cap
 * arithmetic, the lifecycle-module contract, the module registry, and the
 * module-agnostic conformance runner. It is what a second lifecycle module also
 * gets.
 *
 * Everything in that block belongs to **one lifecycle module** and is re-exported
 * here only because hosts written against 0.2 import it from the package root.
 * Each of those symbols is marked `@deprecated` with the subpath that owns it:
 * the engine is not the progressive market, and a root import should not be able
 * to hide that. Reach a module through `requireModule('progressive-market')` or
 * `@axiom-games/reveal-engine/modules/progressive-market`; see `TODO.md` for the
 * retirement schedule, which is shared with the `./protocol`, `./serialization`,
 * and `./reference` aliases.
 */
export * from './api/index.js';
export {
  add,
  compare,
  divide,
  equal,
  floor,
  multiply,
  rational,
  subtract,
  type Rational,
} from './core/rational.js';
export { payable, payableWithinCap } from './core/payments.js';
export { deriveMaxContinuations } from './core/continuation.js';
export { defineLifecycleModule } from './core/module.js';
export { findModule, listModules, requireModule } from './modules/index.js';
export {
  assertModuleConformance,
  checkModuleConformance,
  type ModuleConformanceReport,
} from './conformance/module-conformance.js';

/**
 * @deprecated Progressive-market pricing. Import from
 * `@axiom-games/reveal-engine/modules/progressive-market`; these are one
 * lifecycle module's economics, not the engine's.
 */
export {
  fairValue,
  fairValueClaim,
  initialPosterior,
  posteriorFor,
  probability,
  quote,
  updatePosterior,
} from './modules/progressive-market/posterior.js';
/**
 * @deprecated Progressive-market proofs. Import from
 * `@axiom-games/reveal-engine/modules/progressive-market`; another module
 * derives a different truth and seals a different body.
 */
export {
  deriveTruth,
  makeTranscript,
  verifyTranscript,
  verifyTranscriptDetailed,
} from './modules/progressive-market/fairness.js';
/**
 * @deprecated Progressive-market definitions. Import from
 * `@axiom-games/reveal-engine/modules/progressive-market`.
 */
export { adapterFingerprint, defineGame } from './modules/progressive-market/adapter.js';
/**
 * @deprecated Progressive-market book. Import from
 * `@axiom-games/reveal-engine/modules/progressive-market`; a multi-position
 * module ships its own book with its own actions.
 */
export {
  RoundBook,
  type OpenRequest,
  type Receipt,
  type SellRequest,
  type SettleRequest,
} from './modules/progressive-market/round-book.js';
/**
 * @deprecated Progressive-market transcript codec. Import from
 * `@axiom-games/reveal-engine/modules/progressive-market`; each module owns its
 * own schema and migration set.
 */
export {
  deserializeTranscript,
  serializeTranscript,
  transcriptToWire,
} from './modules/progressive-market/transcript.js';
/**
 * @deprecated Progressive-market view of the generic report. Import from
 * `@axiom-games/reveal-engine/modules/progressive-market`, or use the
 * module-agnostic `checkModuleConformance` above.
 */
export {
  assertAdapterConforms,
  checkAdapterConformance,
} from './modules/progressive-market/conformance.js';
/**
 * @deprecated Import from `@axiom-games/reveal-engine/modules/progressive-market`,
 * or resolve it from the registry with `requireModule('progressive-market')`.
 */
export { progressiveMarket } from './modules/progressive-market/module.js';
/**
 * @deprecated Progressive-market reference definitions. Import from
 * `@axiom-games/reveal-engine/modules/progressive-market`.
 */
export {
  binaryBeaconReference,
  blackSignalReference,
  constellationReference,
} from './modules/progressive-market/references/index.js';
