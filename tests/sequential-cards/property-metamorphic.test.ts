import { describe, expect, it } from 'vitest';
import { multiply, rational, type Rational } from '../../src/core/rational.js';
import { weightProbability } from '../../src/core/weights.js';
import {
  openFingerprint,
  type TicketSelection,
} from '../../src/modules/sequential-cards/round-book.js';
import { forEachCanonicalState } from '../../src/modules/sequential-cards/analysis.js';
import type {
  RevealStep,
  SequentialCardsDefinition,
} from '../../src/modules/sequential-cards/contracts.js';
import {
  cardsBelief,
  cardsBeliefVector,
  claimProbability,
  objectivePositionOf,
} from '../../src/modules/sequential-cards/deck.js';
import { coverProbability, transformedClaim } from '../../src/modules/sequential-cards/pricing.js';
import {
  cascadeMiddleReference,
  duoMiddleReference,
  triadMiddleReference,
} from '../../src/modules/sequential-cards/references.js';
import { deriveRevealSteps, eligiblePositions } from '../../src/modules/sequential-cards/steps.js';
import {
  deriveDeal,
  deriveSelectors,
  enumerateSelectorTuples,
} from '../../src/modules/sequential-cards/truth.js';
import { seed } from '../helpers.js';

const references = [triadMiddleReference, duoMiddleReference, cascadeMiddleReference];

function backingFor(definition: SequentialCardsDefinition): readonly {
  index: number;
  kind: 'back';
  position: number;
}[] {
  return Array.from({ length: definition.backing.maxOpenBeforeReveal }, (_value, index) => ({
    index,
    kind: 'back' as const,
    position: index,
  }));
}

describe('sequential-cards: properties and metamorphic relations', () => {
  /**
   * The posterior is a frequency, checked as one.
   *
   * This groups the **whole** truth space by the public record a round would
   * publish and compares the module's belief to how often the objective card
   * actually lands on each position inside that group. It is the check that
   * would have caught a posterior which read only the most recent published
   * sort and threw away the splits the earlier ones implied — the multi-reveal
   * `cascade-middle-v1` case is included for exactly that reason.
   */
  it.each([
    ['triad-middle-v1', triadMiddleReference],
    ['cascade-middle-v1', cascadeMiddleReference],
  ])(
    'matches the objective frequency over the whole truth space of %s',
    (_id, definition) => {
      const { size, dealt } = definition.ladder;
      const choices = backingFor(definition);
      const selectorTuples = enumerateSelectorTuples(definition);
      const groups = new Map<string, { counts: bigint[]; steps: readonly RevealStep[] }>();
      const ranks: number[] = [];
      const used = new Array<boolean>(size + 1).fill(false);

      const record = (steps: readonly RevealStep[], objective: number): void => {
        const key = steps
          .map((step) => `${step.position}:${step.rank}:${step.sorted.join('.')}`)
          .join('|');
        let group = groups.get(key);
        if (group === undefined) {
          group = { counts: new Array<bigint>(dealt).fill(0n), steps };
          groups.set(key, group);
        }
        group.counts[objective] = (group.counts[objective] as bigint) + 1n;
      };

      const walkRanks = (depth: number): void => {
        if (depth === dealt) {
          const objective = objectivePositionOf(definition, ranks);
          for (const selectors of selectorTuples) {
            const steps = deriveRevealSteps(definition, { ranks, selectors }, choices);
            for (let prefix = 0; prefix <= steps.length; prefix += 1)
              record(steps.slice(0, prefix), objective);
          }
          return;
        }
        for (let rank = 1; rank <= size; rank += 1) {
          if (used[rank] === true) continue;
          used[rank] = true;
          ranks.push(rank);
          walkRanks(depth + 1);
          ranks.pop();
          used[rank] = false;
        }
      };
      walkRanks(0);

      expect(groups.size).toBeGreaterThan(1);
      for (const { counts, steps } of groups.values()) {
        const total = counts.reduce((sum, value) => sum + value, 0n);
        const belief = cardsBelief(definition, steps);
        for (let position = 0; position < dealt; position += 1)
          expect(
            rational(counts[position] as bigint, total),
            `position ${position} after ${steps.length} reveals`,
          ).toEqual(rational(belief.positionWeights[position] as bigint, belief.total));
      }
    },
    120_000,
  );

  it.each(references)('keeps the two belief views agreeing for $id', (definition) => {
    let states = 0;
    forEachCanonicalState(definition, ({ steps, belief }) => {
      states += 1;
      const vector = cardsBeliefVector(definition, steps);
      let total: Rational = rational(0n);
      for (let position = 0; position < definition.ladder.dealt; position += 1) {
        const priced = claimProbability(definition, steps, {
          kind: 'position',
          positions: [position],
        });
        expect(weightProbability(vector, position)).toEqual(priced);
        expect(coverProbability(belief, [position])).toEqual(priced);
        total = rational(
          total.numerator * priced.denominator + priced.numerator * total.denominator,
          total.denominator * priced.denominator,
        );
      }
      expect(total).toEqual(rational(1n));
      // Every side market prices over the same denominator as the positions do.
      for (const market of definition.sideMarkets)
        expect(
          claimProbability(definition, steps, { kind: 'market', marketId: market.id }).denominator,
        ).toBeGreaterThan(0n);
    });
    expect(states).toBeGreaterThan(0);
  });

  it.each(references)('never resurrects an eliminated position for $id', (definition) => {
    const choices = backingFor(definition);
    for (let index = 0; index < 24; index += 1) {
      const seedHex = seed(index);
      const deal = deriveDeal(seedHex, definition, `mono-${index}`);
      const steps = deriveRevealSteps(definition, deal, choices);
      const dead = new Set<number>();
      for (let prefix = 0; prefix <= steps.length; prefix += 1) {
        const belief = cardsBelief(definition, steps.slice(0, prefix));
        for (const position of dead)
          expect(belief.positionWeights[position], `position ${position}`).toBe(0n);
        for (let position = 0; position < definition.ladder.dealt; position += 1)
          if ((belief.positionWeights[position] as bigint) === 0n) dead.add(position);
      }
    }
  });

  it.each(references)(
    'returns a switched claim to itself when it comes back for $id',
    (definition) => {
      const choices = backingFor(definition);
      let checked = 0;
      for (let index = 0; index < 40 && checked < 6; index += 1) {
        const seedHex = seed(index);
        const deal = deriveDeal(seedHex, definition, `switch-${index}`);
        const steps = deriveRevealSteps(definition, deal, choices);
        const belief = cardsBelief(definition, steps);
        const live = belief.record.hidden.filter(
          (position) => (belief.positionWeights[position] as bigint) > 0n,
        );
        if (live.length < 2) continue;
        checked += 1;
        const [from, to] = live as [number, number];
        const claim = rational(288n);
        const moved = transformedClaim(
          definition,
          claim,
          coverProbability(belief, [from]),
          coverProbability(belief, [to]),
        );
        const back = transformedClaim(
          definition,
          moved,
          coverProbability(belief, [to]),
          coverProbability(belief, [from]),
        );
        // With a zero spread a transform is an exact isomorphism, so a round trip
        // is the identity rather than something a rounding rule ate into.
        expect(back).toEqual(claim);
        // And fair value is conserved on the way out.
        expect(multiply(coverProbability(belief, [to]), moved)).toEqual(
          multiply(coverProbability(belief, [from]), claim),
        );
      }
      expect(checked).toBeGreaterThan(0);
    },
  );

  it.each(references)(
    'derives the same round from the same inputs and no others for $id',
    (definition) => {
      const choices = backingFor(definition);
      const seen = new Set<string>();
      for (let index = 0; index < 32; index += 1) {
        const seedHex = seed(index);
        const first = deriveDeal(seedHex, definition, 'purity');
        const second = deriveDeal(seedHex, definition, 'purity');
        expect(second).toEqual(first);
        expect(deriveSelectors(seedHex, definition, 'purity')).toEqual(first.selectors);
        // The round id is a domain separator, so the same seed is a new round.
        expect(deriveDeal(seedHex, definition, 'purity-2')).not.toEqual(first);
        seen.add(JSON.stringify(first));
        // The reveal is exactly the sealed index into the eligible set.
        const steps = deriveRevealSteps(definition, first, choices);
        const revealed = new Set<number>();
        steps.forEach((step, position) => {
          const eligible = eligiblePositions(
            definition,
            new Set(choices.map((choice) => choice.position)),
            revealed,
          );
          expect(eligible[first.selectors[position] as number]).toBe(step.position);
          revealed.add(step.position);
        });
      }
      // 32 seeds must not collapse onto one deal.
      expect(seen.size).toBeGreaterThan(8);
    },
  );

  it('makes the ticket, its order, and its round part of the open command', () => {
    const rows: readonly TicketSelection[] = [
      { id: 'A', kind: 'position', position: 0, stake: 25n },
      { id: 'B', kind: 'market', marketId: 'BAND:LOW', stake: 25n },
    ];
    const base = openFingerprint('round-1', rows);
    expect(openFingerprint('round-1', rows)).toBe(base);
    expect(openFingerprint('round-2', rows)).not.toBe(base);
    expect(openFingerprint('round-1', [...rows].reverse())).not.toBe(base);
    expect(
      openFingerprint('round-1', [
        rows[0] as TicketSelection,
        { ...(rows[1] as TicketSelection), stake: 50n },
      ]),
    ).not.toBe(base);
    expect(
      openFingerprint('round-1', [
        { id: 'A', kind: 'position', position: 1, stake: 25n },
        rows[1] as TicketSelection,
      ]),
    ).not.toBe(base);
  });
});
