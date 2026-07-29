import { describe, expect, it } from 'vitest';
import { RevealEngineError, rational } from '../src/index.js';
import {
  aetherOrderClassic,
  derivePermutation,
  deserializeRoundSnapshot,
  deserializeTranscript,
  exactPayout,
  makePermutationTranscript,
  makeRoundSnapshot,
  openTicket,
  serializeRoundSnapshot,
  serializeTranscript,
  settleTicket,
  verifyPermutationTranscript,
  type Ticket,
} from '../src/modules/permutation/aether/index.js';

const seed = 'ab'.repeat(32);
const context = Object.freeze({
  gameId: 'aether-order',
  variantId: 'classic',
  roundId: 'hostile-round',
  clientSeed: 'player',
  nonce: 3,
});
const seedContext = Object.freeze({
  variantId: 'classic',
  roundId: 'hostile-round',
  nonce: 3,
});

function expectFailure(action: () => unknown, code: string, path: string): void {
  try {
    action();
    throw new Error('Expected action to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(RevealEngineError);
    expect(error).toMatchObject({ code, path });
  }
}

function openedTicket(): Ticket {
  return openTicket(aetherOrderClassic, seedContext, {
    lines: [{ code: 'first', params: { c: 0 }, stake: 100n }],
  });
}

describe('AETHER ORDER hostile-input rejection', () => {
  it('bounds round ids, client seeds, transcripts, and snapshots', () => {
    expectFailure(
      () =>
        derivePermutation(seed, aetherOrderClassic, {
          ...context,
          roundId: 'r'.repeat(129),
        }),
      'INVALID_CONTEXT',
      '$.roundId',
    );
    expectFailure(
      () =>
        derivePermutation(seed, aetherOrderClassic, {
          ...context,
          clientSeed: 's'.repeat(65),
        }),
      'INVALID_CONTEXT',
      '$.clientSeed',
    );
    expectFailure(
      () => deserializeTranscript(' '.repeat(64 * 1024 + 1)),
      'INVALID_TRANSCRIPT',
      '$',
    );
    expectFailure(
      () => deserializeRoundSnapshot(' '.repeat(256 * 1024 + 1)),
      'INVALID_TRANSCRIPT',
      '$',
    );

    const transcript = makePermutationTranscript(seed, aetherOrderClassic, context);
    expectFailure(
      () => serializeTranscript({ ...transcript, roundId: 'x'.repeat(70_000) }),
      'INVALID_CONTEXT',
      '$.roundId',
    );
  });

  it('rejects malformed and tampered transcripts with precise paths', () => {
    const transcript = makePermutationTranscript(seed, aetherOrderClassic, context);
    expectFailure(
      () =>
        settleTicket(
          aetherOrderClassic,
          { ...transcript, permutation: [0, 0, 1, 2, 3] },
          openedTicket(),
        ),
      'INVALID_TRANSCRIPT',
      '$.transcript.permutation',
    );

    const missingSeed = { ...transcript } as Record<string, unknown>;
    delete missingSeed.seedCommitment;
    expect(verifyPermutationTranscript(seed, aetherOrderClassic, missingSeed)).toMatchObject({
      ok: false,
      code: 'INVALID_TRANSCRIPT',
      path: '$.seedCommitment',
    });
    expect(
      verifyPermutationTranscript(seed, aetherOrderClassic, {
        ...transcript,
        previousCommitment: '1'.repeat(64),
      }),
    ).toMatchObject({
      ok: false,
      code: 'COMMITMENT_MISMATCH',
      path: '$.commitment',
    });
    expect(
      verifyPermutationTranscript(seed, aetherOrderClassic, {
        ...transcript,
        permutation: [...transcript.permutation].reverse(),
      }),
    ).toMatchObject({
      ok: false,
      code: 'TRANSCRIPT_MISMATCH',
      path: '$.permutation',
    });
    expect(
      verifyPermutationTranscript('cd'.repeat(32), aetherOrderClassic, transcript),
    ).toMatchObject({ ok: false, code: 'TRANSCRIPT_MISMATCH', path: '$.permutation' });
  });

  it('enforces line limits, stake policy, behavioral uniqueness, and instance legality', () => {
    const line = { code: 'before', params: { a: 0, b: 1 }, stake: 25n };
    expectFailure(
      () =>
        openTicket(aetherOrderClassic, seedContext, {
          lines: Array.from({ length: 13 }, (_, index) => ({
            code: 'full',
            params: { order: `${index % 5}-0-1-2-3` },
            stake: 25n,
          })),
        }),
      'INVALID_TICKET',
      '$.lines',
    );
    for (const [stake, path] of [
      [0n, '$.lines[0].stake'],
      [5025n, '$.lines[0].stake'],
      [26n, '$.lines[0].stake'],
    ] as const)
      expectFailure(
        () =>
          openTicket(aetherOrderClassic, seedContext, {
            lines: [{ ...line, stake }],
          }),
        'INVALID_TICKET',
        path,
      );

    expectFailure(
      () =>
        openTicket(aetherOrderClassic, seedContext, {
          lines: [
            { code: 'first', params: { c: 0 }, stake: 25n },
            { code: 'slot', params: { c: 0, k: 0 }, stake: 25n },
          ],
        }),
      'DUPLICATE_LINE',
      '$.lines[1]',
    );
    expectFailure(
      () =>
        openTicket(aetherOrderClassic, seedContext, {
          lines: [{ code: 'unknown', params: {}, stake: 25n }],
        }),
      'UNKNOWN_BET',
      '$.lines[0].code',
    );
    expectFailure(
      () =>
        openTicket(aetherOrderClassic, seedContext, {
          lines: [{ code: 'first', params: { c: 99 }, stake: 25n }],
        }),
      'UNKNOWN_INSTANCE',
      '$.lines[0].params',
    );
    expectFailure(
      () => exactPayout(25n, rational(1n, 3n), '$.payout'),
      'INEXACT_PAYOUT',
      '$.payout',
    );
  });

  it('rejects an opened ticket carrying a conflicting idempotency key', () => {
    const transcript = makePermutationTranscript(seed, aetherOrderClassic, context);
    const ticket = openedTicket();
    expectFailure(
      () =>
        settleTicket(aetherOrderClassic, transcript, {
          ...ticket,
          idempotencyKey: '0'.repeat(64),
        }),
      'IDEMPOTENCY_CONFLICT',
      '$.idempotencyKey',
    );
  });

  it('fails closed on snapshot money and policy fields and prototype attacks', () => {
    const transcript = makePermutationTranscript(seed, aetherOrderClassic, context);
    const ticket = openedTicket();
    const settlement = settleTicket(aetherOrderClassic, transcript, ticket);
    const snapshot = makeRoundSnapshot({
      game: aetherOrderClassic,
      phase: 'SETTLED',
      seedContext,
      seedCommitment: transcript.seedCommitment,
      transcript,
      ticket,
      settlement,
    });
    const wire = serializeRoundSnapshot(snapshot);

    const missingPolicy = JSON.parse(wire) as Record<string, unknown>;
    delete missingPolicy.playPolicyDigest;
    expectFailure(
      () => deserializeRoundSnapshot(missingPolicy),
      'INVALID_TRANSCRIPT',
      '$.playPolicyDigest',
    );

    expectFailure(
      () => deserializeRoundSnapshot(wire.replace('"stake": "100"', '"stake": 100.5')),
      'INVALID_TICKET',
      '$.settlement.lines[0].stake',
    );

    const polluted = JSON.parse(wire) as {
      ticket: { lines: { params: Record<string, unknown> }[] };
    };
    polluted.ticket.lines[0]!.params = JSON.parse(
      '{"c":0,"__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    expectFailure(
      () => deserializeRoundSnapshot(polluted),
      'INVALID_TRANSCRIPT',
      '$.ticket.lines[0].params.__proto__',
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
