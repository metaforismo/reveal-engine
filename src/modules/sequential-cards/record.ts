import { fail } from '../../api/errors.js';
import { assertIdentifier, isRecord } from '../../core/validation.js';
import type { PlayerChoice, RevealStep, SequentialCardsDefinition } from './contracts.js';

/**
 * What makes a step list usable as **public record**.
 *
 * This lives in its own file for one reason: `deck.ts` has to run it. The
 * posterior is a function of the published record and of nothing else, so a step
 * list that is not well-formed record does not have a posterior — it has a
 * number that looks like one. `validation.ts` cannot host the check, because it
 * already depends on `deck.ts` for the counting bounds, and a module that prices
 * from an unvalidated record is exactly the defect this file exists to close.
 *
 * The rules here are structural and they are all of the ones the posterior
 * depends on: positions and ranks distinct and in range, the published sort the
 * right *width* and a permutation of exactly the positions still hidden, and
 * every earlier sort still consistent with what has since turned face up. They
 * establish internal consistency, **not** provenance — only `settle`, which
 * re-derives the whole list from the revealed seed, establishes that.
 */

/**
 * The width rule, stated on its own because it is the one that silently
 * changes a price rather than raising an error.
 *
 * `revealRecordOf` decides between the ordered branch and the exchangeable one
 * by asking whether the last published sort is as wide as the hidden set. A
 * `sortRemaining: true` definition whose last step carries an empty sort
 * therefore takes the exchangeable branch, discards the published order *and*
 * the cumulative bounds it implies, and prices eliminated outcomes at a finite
 * number. There is no failure to observe: the belief is well-formed, it is just
 * the belief of a different game.
 */
function assertSortWidth(
  definition: SequentialCardsDefinition,
  entry: RevealStep,
  hiddenCount: number,
  path: string,
): void {
  if (!Array.isArray(entry.sorted))
    fail('INVALID_TRANSCRIPT', 'Step sort must be an array', `${path}.sorted`);
  const expectedLength = definition.reveal.sortRemaining ? hiddenCount : 0;
  if (entry.sorted.length !== expectedLength)
    fail('INVALID_TRANSCRIPT', 'Step sort has the wrong width', `${path}.sorted`);
}

/**
 * Validates a reveal step list as public record, against a backing log.
 *
 * `choices` is only read for the eligibility rule: under
 * `eligibility: 'unbacked'` a backed position is never a legal reveal target.
 * Everything else here is a property of the list alone, which is what
 * `assertRevealRecord` exists to expose to the pricing path.
 *
 * That the provenance gap is a money boundary is published, not buried here:
 * `docs/modules/sequential-cards.md` §6.2 works it through with the credit a
 * fabricated reveal earns, §12 lists it among the things this module does not
 * do, `docs/threat-model.md` carries it as an open attack story, and
 * `docs/integration-checklist.md` names the host obligation that closes it —
 * derive every step with `deriveRevealSteps()` against the sealed truth.
 */
export function assertRevealSteps(
  definition: SequentialCardsDefinition,
  choices: readonly PlayerChoice[],
  value: unknown,
  path = '$.steps',
): asserts value is readonly RevealStep[] {
  assertRevealRecord(definition, value, path);
  const backed = new Set(choices.map((choice) => choice.position));
  if (definition.reveal.eligibility !== 'unbacked') return;
  (value as readonly RevealStep[]).forEach((entry, index) => {
    if (backed.has(entry.position))
      fail(
        'INVALID_TRANSCRIPT',
        'A backed position is never eligible for a reveal',
        `${path}[${index}].position`,
        { reason: 'CHOICE_CONFLICT' },
      );
  });
}

/**
 * The half of the record rules that does not need a backing log.
 *
 * `cardsBelief` runs exactly this, because the posterior depends on the
 * published record and on nothing about who backed what. Every caller that
 * carries money — `claimProbability` (the module's `steps.price`),
 * `cardsBeliefVector` (its `steps.belief`) and every book command — reaches the
 * counting through `cardsBelief`, so the guarantee is one call rather than a
 * convention each entry point has to remember.
 */
export function assertRevealRecord(
  definition: SequentialCardsDefinition,
  value: unknown,
  path = '$.steps',
): asserts value is readonly RevealStep[] {
  if (!Array.isArray(value) || value.length > definition.reveal.count)
    fail('INVALID_TRANSCRIPT', 'Steps must be a bounded array', path);
  const revealedPositions = new Set<number>();
  const revealedRanks = new Set<number>();
  value.forEach((step: unknown, index) => {
    const entry = step as RevealStep;
    if (!isRecord(step)) fail('INVALID_TRANSCRIPT', 'Step must be an object', `${path}[${index}]`);
    if (entry.index !== index)
      fail('INVALID_TRANSCRIPT', 'Steps are not densely indexed', `${path}[${index}].index`);
    if (
      !Number.isSafeInteger(entry.position) ||
      entry.position < 0 ||
      entry.position >= definition.ladder.dealt ||
      revealedPositions.has(entry.position)
    )
      fail('INVALID_TRANSCRIPT', 'Step position is invalid', `${path}[${index}].position`);
    if (
      !Number.isSafeInteger(entry.rank) ||
      entry.rank < 1 ||
      entry.rank > definition.ladder.size ||
      revealedRanks.has(entry.rank)
    )
      fail('INVALID_TRANSCRIPT', 'Step rank is invalid', `${path}[${index}].rank`);
    assertIdentifier(entry.label, `${path}[${index}].label`, 'INVALID_TRANSCRIPT');
    revealedPositions.add(entry.position);
    revealedRanks.add(entry.rank);
    const hidden: number[] = [];
    for (let position = 0; position < definition.ladder.dealt; position += 1)
      if (!revealedPositions.has(position)) hidden.push(position);
    assertSortWidth(definition, entry, hidden.length, `${path}[${index}]`);
    const seen = new Set<number>();
    entry.sorted.forEach((position) => {
      if (!hidden.includes(position) || seen.has(position))
        fail(
          'INVALID_TRANSCRIPT',
          'Step sort must be a permutation of the hidden positions',
          `${path}[${index}].sorted`,
        );
      seen.add(position);
    });
    // The published order is cumulative: turning one card face up removes it
    // from the order and moves nothing else. A sort that reordered the survivors
    // would contradict what the board already showed, and the posterior reads
    // both sorts, so the contradiction has to be refused rather than priced.
    if (index > 0 && definition.reveal.sortRemaining) {
      const previous = (value[index - 1] as RevealStep).sorted;
      const expected = previous.filter((position) => position !== entry.position);
      if (
        expected.length !== entry.sorted.length ||
        expected.some((position, slot) => position !== entry.sorted[slot])
      )
        fail(
          'INVALID_TRANSCRIPT',
          'Step sort contradicts the order the board already published',
          `${path}[${index}].sorted`,
        );
    }
  });
}
