export const ENGINE_API_VERSION = 'reveal-engine/api-v1' as const;
export const PERMUTATION_MODULE_VERSION = 'reveal-engine/permutation-v1' as const;
export const PERMUTATION_TRANSCRIPT_SCHEMA = 'reveal-engine/permutation-transcript-v1' as const;
export const PERMUTATION_TICKET_SCHEMA = 'reveal-engine/permutation-ticket-v1' as const;
export const PERMUTATION_RECEIPT_SCHEMA = 'reveal-engine/permutation-receipt-v1' as const;
export const PERMUTATION_SNAPSHOT_SCHEMA = 'reveal-engine/permutation-round-snapshot-v1' as const;

export const AETHER_ORDER_GAME_ID = 'aether-order' as const;
export const ZERO_COMMITMENT = '0'.repeat(64);

export const SEED_COMMIT_DOMAIN = 'aether-order/seed-commit-v1' as const;
export const TICKET_DIGEST_DOMAIN = 'aether-order/ticket-digest-v1' as const;
export const SETTLEMENT_DIGEST_DOMAIN = 'aether-order/settlement-digest-v1' as const;
export const RECEIPT_DOMAIN = 'aether-order/receipt-v1' as const;
export const IDEMPOTENCY_DOMAIN = 'aether-order/idempotency-v1' as const;
export const PLAY_POLICY_DOMAIN = 'aether-order/play-policy-v1' as const;

export const PERMUTATION_LIMITS = Object.freeze({
  maxElements: 12,
  maxExhaustiveElements: 8,
  maxLinesPerTicket: 32,
  maxClientSeedBytes: 64,
  maxRoundIdBytes: 128,
  maxLabelBytes: 128,
  maxSignerIdBytes: 128,
  maxTranscriptBytes: 64 * 1024,
  maxSnapshotBytes: 256 * 1024,
});
