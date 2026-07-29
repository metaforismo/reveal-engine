import { constantTimeHexEqual, encodeFields } from '../internal/canonical.js';
import { normalizeSeed, sha256Hex } from './random.js';
import { COMMITMENT_VERSION } from './versions.js';

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
