import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/aether-order-transcripts.json' with { type: 'json' };
import v2Fixtures from './fixtures/aether-order-transcripts-v2.json' with { type: 'json' };
import {
  aetherOrderClassic,
  aetherOrderSeven,
  ed25519KeyPairFromSeed,
  makePermutationTranscript,
  makeReceipt,
  openTicket,
  permutationAdapterFingerprint,
  settleTicket,
  signReceipt,
  verifyPermutationTranscript,
  verifyReceipt,
  type PermutationGameDefinition,
} from '../src/modules/permutation/aether/index.js';

type FixtureLine = {
  code: string;
  params: Record<string, string | number | boolean>;
  stakeChips: string;
};

function gameFor(variantId: string): PermutationGameDefinition {
  return variantId === 'classic' ? aetherOrderClassic : aetherOrderSeven;
}

function rawTicket(lines: readonly FixtureLine[]) {
  return {
    lines: lines.map((line) => ({
      code: line.code,
      params: line.params,
      stake: BigInt(line.stakeChips),
    })),
  };
}

describe('AETHER ORDER frozen cross-repository vectors', () => {
  /**
   * The file's bytes are the contract, not the object it parses to.
   *
   * `aether-order/docs/ENGINE.md` §10 ends "if a single commitment digest
   * differs, the port is wrong", and this fixture is what that is checked
   * against — it is a verbatim copy of `aether-order/tests/fixtures/
   * transcripts.json`, not an artefact this repository generates.
   * `npm run fixtures:update` does not write it.
   *
   * Every other assertion in this file reads the parsed object, so a reformat —
   * prettier, an editor, a careless `JSON.stringify` round-trip — would leave
   * them all green while the file quietly stopped being a copy. Hence the digest,
   * and hence the `.prettierignore` entry beside it. If this fails, re-copy the
   * file from the game repository rather than editing it here.
   */
  it('is a byte-exact copy of the game repository fixture', () => {
    const bytes = readFileSync(
      new URL('./fixtures/aether-order-transcripts.json', import.meta.url),
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '9db0e2926b4b9ea4cd5c506c635d03d22c09a4f2dc5e4c9d35315665e205b3b7',
    );
  });

  it('keeps both behavioral adapter fingerprints byte-identical', () => {
    expect(permutationAdapterFingerprint(aetherOrderClassic)).toBe(
      fixtures.vectors[0]?.transcript.adapterFingerprint,
    );
    expect(permutationAdapterFingerprint(aetherOrderSeven)).toBe(
      fixtures.vectors[4]?.transcript.adapterFingerprint,
    );
  });

  it('reproduces every digest and deterministic Ed25519 signature in all eight rounds', () => {
    const signerSeed = createHash('sha256')
      .update('aether-order/fixture/operator-key')
      .digest('hex');
    const signer = ed25519KeyPairFromSeed(signerSeed);
    expect(signer.publicKeyHex).toBe(fixtures.operatorPublicKey);

    for (const vector of v2Fixtures.vectors) {
      const game = gameFor(vector.context.variantId);
      const context = { gameId: 'aether-order', ...vector.context };
      const transcript = makePermutationTranscript(
        vector.serverSeed,
        game,
        context,
        vector.transcript.previousCommitment,
      );
      expect(transcript, vector.context.roundId).toEqual(vector.transcript);
      expect(verifyPermutationTranscript(vector.serverSeed, game, transcript).ok).toBe(true);

      const ticket = openTicket(game, vector.context, rawTicket(vector.ticket.lines));
      expect(ticket.ticketDigest, vector.context.roundId).toBe(vector.ticket.ticketDigest);
      expect(ticket.idempotencyKey, vector.context.roundId).toBe(vector.ticket.idempotencyKey);
      expect(ticket.totalStake.toString()).toBe(vector.ticket.totalStakeChips);

      const settlement = settleTicket(game, transcript, ticket);
      expect(settlement.totalStake.toString()).toBe(vector.settlement.totalStakeChips);
      expect(settlement.gross.toString()).toBe(vector.settlement.grossChips);
      expect(settlement.credited.toString()).toBe(vector.settlement.creditedChips);
      expect(settlement.net.toString()).toBe(vector.settlement.netChips);
      expect(settlement.capped).toBe(vector.settlement.capped);
      expect(
        settlement.lines.map((line) => ({
          code: line.code,
          params: line.params,
          stakeChips: line.stake.toString(),
          won: line.won,
          grossChips: line.gross.toString(),
        })),
      ).toEqual(vector.settlement.lines);

      const receipt = signReceipt(
        makeReceipt({
          transcript,
          ticket,
          settlement,
          signerId: fixtures.operatorSignerId,
        }),
        signer.privateKey,
      );
      expect(receipt.digest, vector.context.roundId).toBe(vector.receipt.digest);
      expect(receipt.signature, vector.context.roundId).toBe(vector.receipt.signature);
      expect(receipt.ticketDigest).toBe(vector.receipt.ticketDigest);
      expect(receipt.settlementDigest).toBe(vector.receipt.settlementDigest);
      expect(receipt.seedCommitment).toBe(vector.receipt.seedCommitment);
      expect(receipt.commitment).toBe(vector.receipt.commitment);
      expect(
        verifyReceipt(receipt, {
          transcript,
          ticket,
          settlement,
          publicKey: signer.publicKey,
        }).ok,
      ).toBe(true);
    }
  });
});
