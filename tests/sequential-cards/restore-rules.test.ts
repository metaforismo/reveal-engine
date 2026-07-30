import { describe, expect, it } from 'vitest';
import { RevealEngineError } from '../../src/api/errors.js';
import { commandFingerprint } from '../../src/core/ledger.js';
import { payableWithinCap } from '../../src/core/payments.js';
import { snapshotHash } from '../../src/core/snapshot.js';
import { rational, type Rational } from '../../src/core/rational.js';
import { cardsBelief, claimProbability } from '../../src/modules/sequential-cards/deck.js';
import {
  coverProbability,
  entryClaim,
  fairValue,
  transformedClaim,
} from '../../src/modules/sequential-cards/pricing.js';
import {
  cascadeMiddleReference,
  triadMiddleReference,
} from '../../src/modules/sequential-cards/references.js';
import {
  CardsBook,
  openFingerprint,
  type TicketSelection,
} from '../../src/modules/sequential-cards/round-book.js';
import { deriveRevealSteps, stepDigest } from '../../src/modules/sequential-cards/steps.js';
import { deriveDeal } from '../../src/modules/sequential-cards/truth.js';
import type { RevealStep } from '../../src/modules/sequential-cards/contracts.js';
import { seed } from '../helpers.js';
import { cardsAdmission } from '../support/cards-admission.js';

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

/**
 * These tests target post-binding restore invariants. Their fixture builder is
 * the trusted publisher, so keep that round fixed while mutating other fields.
 */
function restoreSnapshot(definition: typeof triadMiddleReference, input: string | Mutable) {
  const snapshot = typeof input === 'string' ? (JSON.parse(input) as Mutable) : input;
  return CardsBook.restore(definition, input, {
    roundId: snapshot.roundId as string,
    seedCommitment: snapshot.seedCommitment as string,
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
    ...cardsAdmission(definition, SEED, ROUND),
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
            snapshot.roundId as string,
            snapshot.seedCommitment as string,
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
      const restore = (): CardsBook => restoreSnapshot(definition, tampered);
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
      const restore = (): CardsBook => restoreSnapshot(definition, tampered);
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
        ...cardsAdmission(definition, seed(index), roundId),
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
      const restored = CardsBook.restore(definition, book.serialize(), book.publishedRound ?? null);
      expect(restored.snapshot()).toEqual(book.snapshot());
      expect(restored.selections[0]?.claim).toEqual(book.selections[0]?.claim);
      expect(restored.selections[0]?.claim).not.toEqual(rational(0n));
      switched += 1;
    }
    expect(switched).toBe(3);
  });
});

/**
 * The liquidation half of the same question, which is the half that carries the
 * money out of the round.
 *
 * `switch` and `split` move a claim and credit nothing; `cash` credits. So a
 * forged receipt log is worth writing on the `cash` branch and nowhere else, and
 * every case below forges exactly that: a liquidation whose credited integer
 * **re-derives perfectly** from the belief the receipt was fenced to, whose
 * stake, ticket, open receipt and cap basis are all honest, and which no legal
 * command sequence could have produced.
 *
 * The strongest of them is the first. A post-reveal switch grows the claim at
 * the post-reveal belief; a cash fenced back to revision 0 then prices that
 * claim at the pre-reveal one. Nothing in the receipt algebra objects — the
 * arithmetic is exact at both revisions — and the pairing is worth 22× the
 * honest liquidation.
 */
describe('sequential-cards: restore() replays the rules of a liquidation too', () => {
  const CAP_BASIS = 50n;

  async function openedRound(index: number): Promise<{ book: CardsBook; roundId: string }> {
    const roundId = `cash-rules-${index}`;
    const book = new CardsBook(definition);
    await book.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId,
      ...cardsAdmission(definition, seed(index), roundId),
      selections: [
        { id: 'a', kind: 'position', position: 0, stake: 25n },
        { id: 'm', kind: 'market', marketId: 'BAND:CORE', stake: 25n },
      ],
    });
    return { book, roundId };
  }

  /** A round taken through one reveal, filtered on what the reveal left offered. */
  async function revealedRound(
    wants: (book: CardsBook) => boolean,
  ): Promise<{ book: CardsBook; step: RevealStep }> {
    for (let index = 0; index < 64; index += 1) {
      const { book, roundId } = await openedRound(index);
      const deal = deriveDeal(seed(index), definition, roundId);
      const step = deriveRevealSteps(definition, deal, book.choices)[0] as RevealStep;
      await book.advanceReveal({ idempotencyKey: 'reveal', expectedStepRevision: 0, step });
      if (wants(book)) return { book, step };
    }
    throw new Error('no seed in the sweep produced the state this case needs');
  }

  /**
   * A cash-out receipt appended to a snapshot, priced at whatever belief the
   * frame it is fenced to implies.
   *
   * Every derived field moves with it: the credited integer is the one
   * `payableWithinCap` produces at that belief, the `capped` flag is the one the
   * cap chain produces, the selection is marked cashed for that integer, and the
   * liquid balance closes. A restore that refuses this refuses it on the rule,
   * because there is no arithmetic left to refuse it on.
   */
  function forgeCash(base: Mutable, selectionId: string, frame: number): string {
    const rows = base.selections as Mutable[];
    const row = rows.find((candidate) => candidate.id === selectionId);
    if (row === undefined) throw new Error(`no selection ${selectionId} in the fixture`);
    const wire = row.claim as { numerator: string; denominator: string };
    const claim = rational(BigInt(wire.numerator), BigInt(wire.denominator));
    const belief = cardsBelief(definition, (base.steps as RevealStep[]).slice(0, frame));
    const value = fairValue(definition, claim, coverProbability(belief, row.positions as number[]));
    const liquid = BigInt(base.liquidBalance as string);
    const payable = payableWithinCap(value, CAP_BASIS, definition.risk.maxWinMultiple, liquid);
    const fingerprint = commandFingerprint('cash', [
      base.roundId as string,
      base.seedCommitment as string,
      stepDigest((base.steps as RevealStep[]).slice(0, frame)),
      selectionId,
    ]);
    const receipts = [
      ...(base.receipts as WireEntry[]),
      {
        fingerprint,
        receipt: {
          schema: 'reveal-engine/receipt-v1',
          idempotencyKey: 'forged-cash',
          commandFingerprint: fingerprint,
          action: 'cash',
          ledgerRevision: (base.receipts as WireEntry[]).length + 1,
          frameRevision: frame,
          debited: '0',
          credited: String(payable.credited),
          balanceDelta: String(payable.credited),
          capped: payable.capped,
        },
      },
    ];
    return reseal({
      ...base,
      receipts,
      ledgerRevision: receipts.length,
      liquidBalance: String(liquid + payable.credited),
      selections: rows.map((candidate) =>
        candidate.id === selectionId
          ? {
              ...candidate,
              status: 'cashed',
              credited: String(payable.credited),
              decidedAtStepRevision: frame,
            }
          : candidate,
      ),
    });
  }

  /**
   * Refused, and refused **by the named guard**.
   *
   * The message is asserted on purpose. A forged snapshot has many things wrong
   * with it by the time every derived field has been rewritten, and a case that
   * passes because some unrelated check fired first is evidence of nothing: it
   * would keep passing after the guard it is supposed to be about was deleted.
   */
  const refuses = (label: string, tampered: string, guard: string): void => {
    const restore = (): CardsBook => restoreSnapshot(definition, tampered);
    expect(restore, label).toThrowError(RevealEngineError);
    expect(restore, label).toThrowError(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT', message: guard }) as unknown as Error,
    );
  };

  it('refuses a cash-out priced at a belief the round was not standing at', async () => {
    const { book } = await revealedRound((candidate) => {
      const offers = candidate.offers('a');
      const belief = candidate.belief();
      return (
        offers.includes('switch') &&
        offers.includes('cash') &&
        belief.record.hidden.some(
          (position) => position !== 0 && (belief.positionWeights[position] as bigint) > 0n,
        )
      );
    });
    const belief = book.belief();
    const target = belief.record.hidden.find(
      (position) => position !== 0 && (belief.positionWeights[position] as bigint) > 0n,
    ) as number;
    await book.switchClaim({
      idempotencyKey: 'switch',
      expectedStepRevision: 1,
      selectionId: 'a',
      positions: [target],
    });
    const base = JSON.parse(book.serialize()) as Mutable;

    // The blocker itself: the switch is priced at the post-reveal belief and the
    // cash at the pre-reveal one, so the credit is worth strictly more than the
    // honest liquidation of the same claim in the same state.
    const forged = forgeCash(base, 'a', 0);
    const honestValue = fairValue(
      definition,
      book.selections[0]?.claim as Rational,
      coverProbability(belief, [target]),
    );
    const forgedCredit = BigInt(
      (JSON.parse(forged) as { liquidBalance: string }).liquidBalance as string,
    );
    expect(forgedCredit).toBeGreaterThan(
      payableWithinCap(honestValue, CAP_BASIS, definition.risk.maxWinMultiple, 0n).credited,
    );
    refuses(
      'a cash fenced back to the pre-reveal belief',
      forged,
      'Receipt is fenced to a step revision the round was not standing at',
    );

    // Same log, same frames, only the ledger order swapped: the switch is
    // presented before the reveal that made it legal.
    const entries = base.receipts as WireEntry[];
    refuses(
      'a decision presented before the reveal it was fenced to',
      reseal({
        ...base,
        receipts: entries.map((entry) =>
          entry.receipt.action === 'reveal'
            ? { ...entry, receipt: { ...entry.receipt, ledgerRevision: 3 } }
            : entry.receipt.action === 'switch'
              ? { ...entry, receipt: { ...entry.receipt, ledgerRevision: 2 } }
              : entry,
        ),
      }),
      'Receipt is fenced to a step revision the round was not standing at',
    );

    // The decision window, on the branch that credits: the switch already acted
    // at revision 1, so nothing else may.
    refuses(
      'a cash in the window a switch already used',
      forgeCash(base, 'a', 1),
      'Two decisions on one selection inside one decision window',
    );
  });

  it('refuses a liquidation of a row the round never offers one on', async () => {
    const { book } = await revealedRound((candidate) => candidate.offers('a').includes('cash'));
    const base = JSON.parse(book.serialize()) as Mutable;
    // A side market settles from the deal; it has no in-round action at all, and
    // its honest credit here is exactly zero, so only the rule refuses it.
    refuses(
      'a cash-out of a side market',
      forgeCash(base, 'm', 1),
      'A side market settles from the deal and has no in-round liquidation',
    );

    const { book: decided } = await revealedRound(
      (candidate) => candidate.offers('a').length === 0,
    );
    // A reveal that decided the backed cover offers nothing, cash included.
    refuses(
      'a cash-out in a state the reveal already decided',
      forgeCash(JSON.parse(decided.serialize()) as Mutable, 'a', 1),
      'The round did not offer a cash-out in the state the receipt was minted in',
    );

    const { book: unrevealed } = await openedRound(0);
    // Before the first reveal the board is symmetric and no liquidating action
    // is offered; this frame is the one the round really is standing at.
    refuses(
      'a cash-out before the first reveal',
      forgeCash(JSON.parse(unrevealed.serialize()) as Mutable, 'a', 0),
      'The round did not offer a cash-out in the state the receipt was minted in',
    );
  });

  it('still restores a round that really did cash out', async () => {
    const { book } = await revealedRound((candidate) => candidate.offers('a').includes('cash'));
    await book.cash({ idempotencyKey: 'cash', expectedStepRevision: 1, selectionId: 'a' });
    expect(book.liquidBalance).toBeGreaterThan(0n);
    const restored = CardsBook.restore(definition, book.serialize(), book.publishedRound ?? null);
    expect(restored.snapshot()).toEqual(book.snapshot());
    expect(restored.liquidBalance).toBe(book.liquidBalance);
  });
});

/**
 * The same rules on a **multi-reveal** definition, where the frame really has
 * more than two values to be wrong about.
 *
 * `triad-middle-v1` has one reveal, so "the frame is 0 or 1" is nearly a
 * boolean and a guard could pass by accident. `cascade-middle-v1` reveals twice,
 * so a receipt can be fenced to a middle revision the round has already left —
 * and that is where a claim grown at the second belief and priced at the first
 * would live.
 */
describe('sequential-cards: the frame rule on a two-reveal round', () => {
  const cascade = cascadeMiddleReference;

  it('refuses a liquidation fenced to a revision the round has already left', async () => {
    // Swept rather than fixed: a two-reveal round can decide the backed cover
    // on the way, and a state that offers nothing has no positive control in it.
    let base: Mutable | undefined;
    for (let index = 0; index < 48 && base === undefined; index += 1) {
      const roundId = `cascade-frames-${index}`;
      const book = new CardsBook(cascade);
      await book.open({
        idempotencyKey: 'open',
        expectedStepRevision: 0,
        roundId,
        ...cardsAdmission(cascade, seed(index), roundId),
        selections: [{ id: 'a', kind: 'position', position: 0, stake: 10n }],
      });
      const deal = deriveDeal(seed(index), cascade, roundId);
      const steps = deriveRevealSteps(cascade, deal, book.choices);
      await book.advanceReveal({
        idempotencyKey: 'reveal-0',
        expectedStepRevision: 0,
        step: steps[0] as RevealStep,
      });
      await book.advanceReveal({
        idempotencyKey: 'reveal-1',
        expectedStepRevision: 1,
        step: steps[1] as RevealStep,
      });
      if (book.offers('a').includes('cash')) base = JSON.parse(book.serialize()) as Mutable;
    }
    if (base === undefined) throw new Error('no cascade seed left a cash-out offered');
    expect(base.stepRevision).toBe(2);

    const fixture = base;
    const forge = (frame: number): string => {
      const row = (fixture.selections as Mutable[])[0] as Mutable;
      const wire = row.claim as { numerator: string; denominator: string };
      const belief = cardsBelief(cascade, (fixture.steps as RevealStep[]).slice(0, frame));
      const value = fairValue(
        cascade,
        rational(BigInt(wire.numerator), BigInt(wire.denominator)),
        coverProbability(belief, row.positions as number[]),
      );
      const payable = payableWithinCap(value, 10n, cascade.risk.maxWinMultiple, 0n);
      const fingerprint = commandFingerprint('cash', [
        fixture.roundId as string,
        fixture.seedCommitment as string,
        stepDigest((fixture.steps as RevealStep[]).slice(0, frame)),
        'a',
      ]);
      const receipts = [
        ...(fixture.receipts as WireEntry[]),
        {
          fingerprint,
          receipt: {
            schema: 'reveal-engine/receipt-v1',
            idempotencyKey: 'forged-cash',
            commandFingerprint: fingerprint,
            action: 'cash',
            ledgerRevision: (fixture.receipts as WireEntry[]).length + 1,
            frameRevision: frame,
            debited: '0',
            credited: String(payable.credited),
            balanceDelta: String(payable.credited),
            capped: payable.capped,
          },
        },
      ];
      return reseal({
        ...fixture,
        receipts,
        ledgerRevision: receipts.length,
        liquidBalance: String(payable.credited),
        selections: (fixture.selections as Mutable[]).map((entry) => ({
          ...entry,
          status: 'cashed',
          credited: String(payable.credited),
          decidedAtStepRevision: frame,
        })),
      });
    };

    for (const frame of [0, 1]) {
      const restore = (): CardsBook => restoreSnapshot(cascade, forge(frame));
      expect(restore, `a cash fenced to revision ${frame}`).toThrowError(
        expect.objectContaining({
          code: 'INVALID_SNAPSHOT',
          message: 'Receipt is fenced to a step revision the round was not standing at',
        }) as unknown as Error,
      );
    }
    // The frame the round really is standing at restores, so the rule refuses a
    // pairing rather than refusing liquidations.
    expect(() => restoreSnapshot(cascade, forge(2))).not.toThrow();
  });
});
