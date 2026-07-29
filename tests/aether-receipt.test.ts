import { describe, expect, it } from 'vitest';
import {
  aetherOrderClassic,
  ed25519KeyPairFromSeed,
  makePermutationTranscript,
  makeReceipt,
  openTicket,
  settleTicket,
  signReceipt,
  verifyReceipt,
} from '../src/modules/permutation/aether/index.js';

function round() {
  const transcript = makePermutationTranscript('ab'.repeat(32), aetherOrderClassic, {
    gameId: 'aether-order',
    variantId: 'classic',
    roundId: 'receipt-round',
    clientSeed: 'player',
    nonce: 7,
  });
  const ticket = openTicket(
    aetherOrderClassic,
    { variantId: 'classic', roundId: 'receipt-round', nonce: 7 },
    { lines: [{ code: 'first', params: { c: 0 }, stake: 100n }] },
  );
  const settlement = settleTicket(aetherOrderClassic, transcript, ticket);
  const key = ed25519KeyPairFromSeed('11'.repeat(32));
  const otherKey = ed25519KeyPairFromSeed('22'.repeat(32));
  const receipt = signReceipt(
    makeReceipt({ transcript, ticket, settlement, signerId: 'axiom-games/test' }),
    key.privateKey,
  );
  return { transcript, ticket, settlement, key, otherKey, receipt };
}

describe('AETHER ORDER receipt tri-state and bindings', () => {
  it('passes only after checking a valid operator signature', () => {
    const { transcript, ticket, settlement, key, receipt } = round();
    expect(
      verifyReceipt(receipt, {
        transcript,
        ticket,
        settlement,
        publicKey: key.publicKey,
      }),
    ).toMatchObject({
      ok: true,
      signatureChecked: true,
      signatureValid: true,
      bindingsVerified: true,
    });
  });

  it('returns SIGNATURE_UNCHECKED, never ok, when no public key is supplied', () => {
    const { transcript, ticket, settlement, receipt } = round();
    expect(verifyReceipt(receipt, { transcript, ticket, settlement })).toMatchObject({
      ok: false,
      code: 'SIGNATURE_UNCHECKED',
      path: '$.signature',
      signatureChecked: false,
      signatureValid: null,
      bindingsVerified: true,
    });
  });

  it('rejects every mutated binding field under the contract error taxonomy', () => {
    const { transcript, ticket, settlement, key, otherKey, receipt } = round();
    const restaked = {
      lines: ticket.lines.map((line, index) =>
        index === 0 ? { ...line, stake: line.stake + 25n } : line,
      ),
    };
    expect(
      verifyReceipt(receipt, {
        transcript,
        ticket: restaked,
        settlement,
        publicKey: key.publicKey,
      }),
    ).toMatchObject({
      ok: false,
      code: 'TRANSCRIPT_MISMATCH',
      path: '$.ticketDigest',
    });

    expect(
      verifyReceipt(receipt, {
        transcript,
        ticket,
        settlement: { ...settlement, credited: settlement.credited + 1n },
        publicKey: key.publicKey,
      }),
    ).toMatchObject({
      ok: false,
      code: 'TRANSCRIPT_MISMATCH',
      path: '$.settlementDigest',
    });

    for (const [field, mutated] of [
      ['commitment', { ...transcript, commitment: '1'.repeat(64) }],
      ['seedCommitment', { ...transcript, seedCommitment: '2'.repeat(64) }],
    ] as const)
      expect(
        verifyReceipt(receipt, {
          transcript: mutated,
          ticket,
          settlement,
          publicKey: key.publicKey,
        }),
        field,
      ).toMatchObject({ ok: false, code: 'COMMITMENT_MISMATCH', path: `$.${field}` });

    expect(
      verifyReceipt(
        { ...receipt, signerId: 'someone-else' },
        { transcript, ticket, settlement, publicKey: key.publicKey },
      ),
    ).toMatchObject({
      ok: false,
      code: 'COMMITMENT_MISMATCH',
      path: '$.digest',
    });

    expect(
      verifyReceipt(receipt, {
        transcript,
        ticket,
        settlement,
        publicKey: otherKey.publicKey,
      }),
    ).toMatchObject({
      ok: false,
      code: 'COMMITMENT_MISMATCH',
      path: '$.signature',
      signatureChecked: true,
      signatureValid: false,
      bindingsVerified: true,
    });
  });
});
