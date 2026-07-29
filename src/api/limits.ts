/** Public validation/DoS limits; changing one requires an API compatibility review. */
export const ENGINE_LIMITS = Object.freeze({
  maxOutcomes: 64,
  maxEvidenceEvents: 10_000,
  maxIdentifierBytes: 128,
  maxLabelBytes: 128,
  maxIdempotencyKeyBytes: 128,
  maxBigIntBits: 4096,
  maxTranscriptBytes: 8 * 1024 * 1024,
  maxSnapshotBytes: 16 * 1024 * 1024,
  /** Receipts retained by one round ledger, shared by every lifecycle module. */
  maxReceipts: 10_000,
  /** Simultaneous open claims a lifecycle module may hold in one round book. */
  maxRoundClaims: 64,
  /** Player choices a lifecycle module may log as deterministic transcript inputs. */
  maxLoggedChoices: 10_000,
  /** Steps a lifecycle module may declare for one round. */
  maxSteps: 10_000,
  /**
   * Elements in one seeded permutation draw (deck shuffles, ordered truth models).
   *
   * This bounds shuffling, not counting: an exact count is separately bounded by
   * `maxBigIntBits`, which `536!` already reaches. `core/combinatorics.ts`
   * enforces that second bound with `INVALID_WEIGHTS`.
   */
  maxPermutationSize: 1_024,
  /** Draws one recorded random tape may contain. */
  maxTapeDraws: 10_000,
});
