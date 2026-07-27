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
});
