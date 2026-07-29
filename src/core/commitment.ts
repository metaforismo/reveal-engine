import { fail } from '../api/errors.js';
import { constantTimeHexEqual, encodeFields } from '../internal/canonical.js';
import { normalizeSeed, sha256Hex } from './random.js';
import { assertIdentifier, assertProofVersion, isRecord } from './validation.js';
import { COMMITMENT_VERSION, type CommitmentVersion } from './versions.js';

/**
 * Commit-reveal sealing, independent of what is being committed to.
 *
 * A lifecycle module produces a canonical `body` for its round (truth, steps,
 * definition identity, logged choices) and core seals it under the seed. Because
 * every field inside `body` is length-prefixed by `encodeFields`, no module can
 * craft two different rounds that encode to the same bytes.
 */
export function sealCommitment(seedHex: string, body: Uint8Array): string {
  const seed = normalizeSeed(seedHex);
  return sha256Hex(
    encodeFields(['commitment', COMMITMENT_VERSION, Buffer.from(seed, 'hex'), body]),
  );
}

/** Everything a seed pre-commitment binds besides the seed itself. */
export interface SeedCommitmentBinding {
  readonly moduleId: string;
  readonly definitionId: string;
  /** The definition fingerprint, so the economics are fixed before the first decision. */
  readonly definitionFingerprint: string;
  readonly roundId: string;
  readonly proofVersion: CommitmentVersion;
}

/**
 * Seals a seed on its own, before the round has a body to seal.
 *
 * `sealCommitment` needs the finished transcript, which a module with
 * `choiceTiming: 'before-step'` does not have until the round is over — yet the
 * player's first decision must already be covered by a published commitment.
 * The protocol is two-phase:
 *
 * 1. **Before the round opens**, publish `sealSeedCommitment(seed, binding)`.
 *    It binds the seed, the module, the definition *fingerprint* (so the
 *    economics are frozen too), and the round id. It reveals nothing: it is a
 *    hash of an unrevealed 32-byte seed.
 * 2. **When the round settles**, publish the transcript and the revealed seed.
 *    The verifier re-derives the seed commitment from the revealed seed and
 *    checks it against what was published in phase 1, then re-derives the
 *    transcript commitment over the truth, the steps, and the logged choices.
 *
 * Phase 1 is what makes a choice-timed round fair: the operator cannot pick a
 * seed after seeing a decision, because the seed was sealed and published
 * before any decision existed. `RandomTape` then proves the draws were the
 * expansion of *that* seed, in that order. The two mechanisms answer different
 * questions and a choice-timed module needs both.
 *
 * The domain tag differs from `sealCommitment`, so a seed commitment can never
 * collide with a body commitment.
 */
export function sealSeedCommitment(seedHex: string, binding: SeedCommitmentBinding): string {
  const seed = normalizeSeed(seedHex);
  if (!isRecord(binding))
    fail('INVALID_CONTEXT', 'Expected a seed commitment binding', '$.binding');
  assertIdentifier(binding.moduleId, '$.binding.moduleId', 'INVALID_CONTEXT');
  assertIdentifier(binding.definitionId, '$.binding.definitionId', 'INVALID_CONTEXT');
  assertIdentifier(binding.roundId, '$.binding.roundId', 'INVALID_CONTEXT');
  if (
    typeof binding.definitionFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(binding.definitionFingerprint)
  )
    fail(
      'INVALID_CONTEXT',
      'Expected canonical 32-byte definition fingerprint',
      '$.binding.definitionFingerprint',
    );
  assertProofVersion(binding.proofVersion, '$.binding.proofVersion');
  return sha256Hex(
    encodeFields([
      'seed-commitment',
      COMMITMENT_VERSION,
      Buffer.from(seed, 'hex'),
      binding.moduleId,
      binding.definitionId,
      binding.definitionFingerprint,
      binding.roundId,
      binding.proofVersion,
    ]),
  );
}

/**
 * Legacy `commit-v1` sealing: `sha256(seedHex | delimiter-joined payload)`.
 *
 * Verification only. The seed string is hashed as written (after a format check)
 * because the historical scheme did so; new rounds must use `sealCommitment`.
 */
export function sealLegacyCommitment(seedHex: string, payload: string): string {
  normalizeSeed(seedHex);
  return sha256Hex(`${seedHex}|${payload}`);
}

export { constantTimeHexEqual };
