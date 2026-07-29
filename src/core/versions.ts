/** Engine-wide identity constants. Every value here is a wire-visible contract. */

/** Public runtime/type contract shared by core and every lifecycle module. */
export const ENGINE_API_VERSION = 'reveal-engine/api-v1' as const;

/** Contract a lifecycle module implements. Bumped when the module interface breaks. */
export const MODULE_API_VERSION = 'reveal-engine/module-v1' as const;

/** Verification-only legacy commitment scheme (delimiter-joined payload). */
export const LEGACY_COMMITMENT_VERSION = 'reveal-engine/commit-v1' as const;

/** Current commitment scheme: length-prefixed canonical fields under a domain tag. */
export const COMMITMENT_VERSION = 'reveal-engine/commit-v2' as const;

export type CommitmentVersion = typeof LEGACY_COMMITMENT_VERSION | typeof COMMITMENT_VERSION;
