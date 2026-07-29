import { describe, expect, it } from 'vitest';
import { RevealEngineError } from '../../src/api/errors.js';
import { commandFingerprint } from '../../src/core/ledger.js';
import { snapshotHash } from '../../src/core/snapshot.js';
import { rational, type Rational } from '../../src/core/rational.js';
import { cardsBelief, claimProbability } from '../../src/modules/sequential-cards/deck.js';
import {
  coverProbability,
  entryClaim,
  transformedClaim,
} from '../../src/modules/sequential-cards/pricing.js';
import { triadMiddleReference } from '../../src/modules/sequential-cards/references.js';
import {
  CardsBook,
  openFingerprint,
  type TicketSelection,
} from '../../src/modules/sequential-cards/round-book.js';
import { deriveRevealSteps, stepDigest } from '../../src/modules/sequential-cards/steps.js';
import { deriveDeal } from '../../src/modules/sequential-cards/truth.js';
import type { RevealStep } from '../../src/modules/sequential-cards/contracts.js';
import { seed } from '../helpers.js';

const definition = triadMiddleReference;
const SEED = seed(53);
const ROUND = 'restore-rules';

type Mutable = Record<string, unknown>;

/**
 * Every snapshot below is **re-sealed**, and every derived field is updated to
 * match the forged replay.
 *
 * That is the whole point. A tamper the checksum catches proves nothing: anyone
 * who can rewrite the store can recompute an unkeyed hash over what they wrote,
 * and the receipt fingerprints are unkeyed too. So each case here presents a
 * snapshot whose receipts, claims, covers, decision log and checksum are all
 * internally consistent with one another, and asks the only question that is
 * left — whether `restore()` replays the **module's own state-machine rules** or
 * only the receipt algebra. `docs/lifecycle-modules.md` is normative that it is
 * the former: a decision the round would have refused is neither an
 * inconsistency nor the stake, and it must not survive a reconnect.
 */
function reseal(value: Mutable): string {
  return JSON.stringify({
    ...value,
    snapshotHash: snapshotHash({ ...value, snapshotHash: undefined }),
  });
}

interface WireEntry {
  readonly fingerprint: string;
  readonly receipt: Mutable;
}

async function stakedRound(): Promise<{
  snapshot: Mutable;
  step: RevealStep;
  claim: Rational;
  positions: readonly number[];
}> {
  const book = new CardsBook(definition);
  await book.open({
    idempotencyKey: 'open',
    expectedStepRevision: 0,
    roundId: ROUND,
    selections: [{ id: 'a', kind: 'position', position: 0, stake: 25n }],
  });
  const deal = deriveDeal(SEED, definition, ROUND);
  const step = deriveRevealSteps(definition, deal, book.choices)[0] as RevealStep;
  await book.advanceReveal({ idempotencyKey: 'reveal', expectedStepRevision: 0, step });
  const selection = book.selections[0];
  if (selection === undefined) throw new Error('the fixture needs one live selection');
  return {
    snapshot: JSON.parse(book.serialize()) as Mutable,
    step,
    claim: selection.claim,
    positions: selection.positions,
  };
}

describe("sequential-cards: restore() replays the round's own rules", () => {
  it('refuses a decision log the live book would have refused, however consistent it is', async () => {
    const { snapshot, step, claim, positions } = await stakedRound();
    const belief = cardsBelief(definition, [step]);
    const hidden = belief.record.hidden.filter(
      (position) => (belief.positionWeights[position] as bigint) > 0n,
    );
    const other = hidden.find((position) => position !== 0);
    if (other === undefined) throw new Error('the fixture needs a second live position');

    /**
     * A forged decision chain, priced and fingerprinted exactly as the book
     * would price and fingerprint it.
     *
     * `priced: false` is for covers that have no price at all — an out-of-range
     * index, a repeat, a width the action does not take. Those keep the honest
     * claim, which is the strongest form of the case: the arithmetic in the
     * snapshot is beyond reproach and only the cover is impossible.
     */
    const forge = (
      chain: readonly { action: 'switch' | 'split'; positions: number[] }[],
      priced = true,
    ): string => {
      let running: Rational = claim;
      let cover: readonly number[] = positions;
      if (priced)
        for (const link of chain) {
          running = transformedClaim(
            definition,
            running,
            coverProbability(belief, cover),
            coverProbability(belief, link.positions),
          );
          cover = link.positions;
        }
      const receipts = [
        ...(snapshot.receipts as WireEntry[]),
        ...chain.map((link, index) => {
          const fingerprint = commandFingerprint(link.action, [
            stepDigest([step]),
            'a',
            link.positions.length,
            ...link.positions,
          ]);
          return {
            fingerprint,
            receipt: {
              schema: 'reveal-engine/receipt-v1',
              idempotencyKey: `forged-${index}`,
              commandFingerprint: fingerprint,
              action: link.action,
              ledgerRevision: 3 + index,
              frameRevision: 1,
              debited: '0',
              credited: '0',
              balanceDelta: '0',
              capped: false,
            },
          };
        }),
      ];
      return reseal({
        ...snapshot,
        receipts,
        ledgerRevision: receipts.length,
        decisions: chain.map((link) => ({
          selectionId: 'a',
          action: link.action,
          stepRevision: 1,
          positions: link.positions,
        })),
        selections: (snapshot.selections as Mutable[]).map((row) => ({
          ...row,
          positions: [...cover],
          claim: { numerator: String(running.numerator), denominator: String(running.denominator) },
          decidedAtStepRevision: 1,
        })),
      });
    };

    const faceUp = step.position;
    const cases: readonly [string, string][] = [
      // A claim may only move onto a card that is still face down.
      ['switch onto the revealed card', forge([{ action: 'switch', positions: [faceUp] }])],
      [
        'split covering the revealed card',
        forge([
          {
            action: 'split',
            positions: [Math.min(faceUp, other), Math.max(faceUp, other)],
          },
        ]),
      ],
      // One action per decision window; §5.2 says the bound is load-bearing.
      [
        'two switches inside one decision window',
        forge([
          { action: 'switch', positions: [other] },
          { action: 'switch', positions: [0] },
        ]),
      ],
      // The live path always sorts and de-duplicates a cover.
      [
        'an unsorted cover no command could have written',
        forge([
          {
            action: 'split',
            positions: [Math.max(faceUp, other), Math.min(faceUp, other)],
          },
        ]),
      ],
      // The one untrusted array whose rules belong to the definition.
      ['an out-of-range cover', forge([{ action: 'switch', positions: [999] }], false)],
      ['a negative cover position', forge([{ action: 'switch', positions: [-1] }], false)],
      ['a repeated cover position', forge([{ action: 'split', positions: [other, other] }], false)],
      [
        'a switch naming two positions',
        forge([{ action: 'switch', positions: [0, other] }], false),
      ],
    ];

    for (const [label, tampered] of cases) {
      const restore = (): CardsBook => CardsBook.restore(definition, tampered);
      expect(restore, label).toThrowError(RevealEngineError);
      expect(restore, label).toThrowError(
        expect.objectContaining({ code: 'INVALID_SNAPSHOT' }) as unknown as Error,
      );
    }
  });

  it('refuses a restored ticket the open command would have refused', async () => {
    const { snapshot } = await stakedRound();
    const first = (snapshot.selections as Mutable[])[0] as Mutable;

    /**
     * Rewrites the ticket **and its open receipt together**, so the receipt
     * algebra has nothing left to object to: the fingerprint is recomputed over
     * the forged rows, the debit and the cap basis are the forged total, and
     * every claim is the price the forged stake really buys. What is left is
     * only the question of whether the ticket is one `open()` would have taken.
     */
    const withTicket = (
      rows: readonly TicketSelection[],
      choices: readonly { index: number; kind: 'back'; position: number }[],
    ): string => {
      const total = rows.reduce((sum, row) => sum + row.stake, 0n);
      const fingerprint = openFingerprint(ROUND, rows);
      const prior = cardsBelief(definition, []);
      const receipts = (snapshot.receipts as WireEntry[]).map((entry, index) =>
        index === 0
          ? {
              fingerprint,
              receipt: {
                ...entry.receipt,
                commandFingerprint: fingerprint,
                debited: String(total),
                balanceDelta: String(-total),
              },
            }
          : entry,
      );
      return reseal({
        ...snapshot,
        choices,
        capBasisStake: String(total),
        receipts,
        selections: rows.map((row) => {
          const probability =
            row.kind === 'position'
              ? coverProbability(prior, [row.position])
              : claimProbability(definition, [], { kind: 'market', marketId: row.marketId });
          const claim = entryClaim(definition, row.stake, probability);
          return {
            ...first,
            id: row.id,
            kind: row.kind,
            marketId: row.kind === 'market' ? row.marketId : null,
            openedPosition: row.kind === 'position' ? row.position : null,
            positions: row.kind === 'position' ? [row.position] : [],
            stake: String(row.stake),
            claim: { numerator: String(claim.numerator), denominator: String(claim.denominator) },
          };
        }),
      });
    };

    const backing = [{ index: 0, kind: 'back' as const, position: 0 }];
    const cases: readonly [string, string][] = [
      [
        'a stake off the declared lattice',
        withTicket([{ id: 'a', kind: 'position', position: 0, stake: 30n }], backing),
      ],
      [
        'a stake below the declared minimum',
        withTicket([{ id: 'a', kind: 'position', position: 0, stake: 0n }], backing),
      ],
      [
        'a ticket of side markets alone, which has no reveal to derive',
        withTicket([{ id: 'm', kind: 'market', marketId: 'BAND:CORE', stake: 25n }], []),
      ],
    ];
    for (const [label, tampered] of cases) {
      const restore = (): CardsBook => CardsBook.restore(definition, tampered);
      expect(restore, label).toThrowError(RevealEngineError);
      expect(restore, label).toThrowError(
        expect.objectContaining({ code: 'INVALID_SNAPSHOT' }) as unknown as Error,
      );
    }
  });

  it('still restores every snapshot a legal command sequence can write', async () => {
    // The rules restore() now applies must refuse only what the live book
    // refuses, so the same sequence that succeeds against the book has to
    // survive a reconnect. Seeds are walked until one leaves a switch offered:
    // a reveal that decides the backed cover legitimately offers nothing.
    let switched = 0;
    for (let index = 0; index < 24 && switched < 3; index += 1) {
      const roundId = `legal-round-${index}`;
      const book = new CardsBook(definition);
      await book.open({
        idempotencyKey: 'open',
        expectedStepRevision: 0,
        roundId,
        selections: [
          { id: 'a', kind: 'position', position: 0, stake: 25n },
          { id: 'm', kind: 'market', marketId: 'BAND:CORE', stake: 50n },
        ],
      });
      const deal = deriveDeal(seed(index), definition, roundId);
      const step = deriveRevealSteps(definition, deal, book.choices)[0] as RevealStep;
      await book.advanceReveal({ idempotencyKey: 'reveal', expectedStepRevision: 0, step });
      if (!book.offers('a').includes('switch')) continue;
      const belief = book.belief();
      const target = belief.record.hidden.find(
        (position) => position !== 0 && (belief.positionWeights[position] as bigint) > 0n,
      );
      if (target === undefined) continue;
      await book.switchClaim({
        idempotencyKey: 'switch',
        expectedStepRevision: 1,
        selectionId: 'a',
        positions: [target],
      });
      const restored = CardsBook.restore(definition, book.serialize());
      expect(restored.snapshot()).toEqual(book.snapshot());
      expect(restored.selections[0]?.claim).toEqual(book.selections[0]?.claim);
      expect(restored.selections[0]?.claim).not.toEqual(rational(0n));
      switched += 1;
    }
    expect(switched).toBe(3);
  });
});
