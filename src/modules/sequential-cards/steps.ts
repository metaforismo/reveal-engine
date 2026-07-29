import { fail } from '../../api/errors.js';
import { sha256Hex } from '../../core/random.js';
import { encodeFields, type CanonicalField } from '../../internal/canonical.js';
import type { Deal, PlayerChoice, RevealStep, SequentialCardsDefinition } from './contracts.js';
import {
  assertCardsDefinition,
  assertPlayerChoices,
  eligibleSetSize,
  reject,
} from './validation.js';

/**
 * Reveal derivation: a pure function of `(sealed truth, logged choices)`.
 *
 * No sampling happens here. Every draw the round needs was sealed with the deal,
 * so a reveal is a deterministic replay of committed randomness against a public
 * decision log — which is exactly what makes the transcript re-derivable by
 * somebody who trusts neither the operator nor the client.
 */

/** Positions a reveal may take at `index`, in ascending board order. */
export function eligiblePositions(
  definition: SequentialCardsDefinition,
  backed: ReadonlySet<number>,
  revealed: ReadonlySet<number>,
): readonly number[] {
  const eligible: number[] = [];
  for (let position = 0; position < definition.ladder.dealt; position += 1) {
    if (revealed.has(position)) continue;
    if (definition.reveal.eligibility === 'unbacked' && backed.has(position)) continue;
    eligible.push(position);
  }
  return eligible;
}

export function deriveRevealSteps(
  definition: SequentialCardsDefinition,
  deal: Deal,
  choices: readonly PlayerChoice[],
): readonly RevealStep[] {
  assertCardsDefinition(definition);
  assertPlayerChoices(definition, choices);
  // The eligible set was sized against the declared backing width when the
  // selector was sealed, so a round that logs fewer decisions than the width is
  // not the round that was committed to.
  if (
    definition.reveal.eligibility === 'unbacked' &&
    choices.length !== definition.backing.maxOpenBeforeReveal
  )
    reject(
      'INVALID_CHOICE',
      'Every backed position must be logged before the first reveal',
      '$.choices',
      'CHOICE_REQUIRED',
    );
  const backed = new Set(choices.map((choice) => choice.position));
  const revealed = new Set<number>();
  const steps: RevealStep[] = [];
  for (let index = 0; index < definition.reveal.count; index += 1) {
    const eligible = eligiblePositions(definition, backed, revealed);
    if (eligible.length !== eligibleSetSize(definition, index))
      fail(
        'DERIVATION_FAILED',
        'Eligible set does not match the size the selector was sealed against',
        `$.steps[${index}]`,
      );
    const selector = deal.selectors[index];
    if (selector === undefined || selector < 0 || selector >= eligible.length)
      fail(
        'DERIVATION_FAILED',
        'Sealed selector is outside the eligible set',
        `$.deal.selectors[${index}]`,
      );
    const position = eligible[selector] as number;
    const rank = deal.ranks[position];
    if (rank === undefined)
      fail('DERIVATION_FAILED', 'Deal has no card at that position', '$.deal');
    revealed.add(position);
    const hidden: number[] = [];
    for (let candidate = 0; candidate < definition.ladder.dealt; candidate += 1)
      if (!revealed.has(candidate)) hidden.push(candidate);
    const sorted = definition.reveal.sortRemaining
      ? [...hidden].sort(
          (left, right) => (deal.ranks[left] as number) - (deal.ranks[right] as number),
        )
      : [];
    steps.push(
      Object.freeze({
        index,
        position,
        rank,
        sorted: Object.freeze(sorted),
        // The label is a function of the definition and the step index only, so
        // the schedule's shape is identical whichever deal was drawn. Only the
        // targets differ, which is what a reveal is allowed to disclose.
        label: `${definition.reveal.modelVersion}:${index}`,
      }),
    );
  }
  return Object.freeze(steps);
}

/** The module's `steps.encode`; `cardsCommitmentBody` composes this same function. */
export function encodeRevealStep(step: RevealStep): readonly CanonicalField[] {
  return Object.freeze([
    step.index,
    step.position,
    step.rank,
    step.sorted.length,
    ...step.sorted,
    step.label,
  ]);
}

export function revealStepsEqual(
  left: readonly RevealStep[],
  right: readonly RevealStep[],
): boolean {
  return (
    left.length === right.length &&
    left.every((step, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        step.index === other.index &&
        step.position === other.position &&
        step.rank === other.rank &&
        step.label === other.label &&
        step.sorted.length === other.sorted.length &&
        step.sorted.every((position, slot) => position === other.sorted[slot])
      );
    })
  );
}

/**
 * 32-byte digest of a step prefix, folded into every command fingerprint.
 *
 * A book command is fenced to a step revision, but a revision is only a number:
 * a reconnect snapshot that rewrote what the reveals *said* while keeping the
 * count would leave every receipt looking canonical. Binding the digest means a
 * rewritten reveal cannot survive the receipts that were minted against it.
 */
export function stepDigest(steps: readonly RevealStep[]): string {
  return sha256Hex(
    encodeFields([
      'cards-steps',
      steps.length,
      ...steps.flatMap((step) => [...encodeRevealStep(step)]),
    ]),
  );
}

/** Choice log encoding, bound into the commitment body alongside truth and steps. */
export function encodePlayerChoice(choice: PlayerChoice): readonly CanonicalField[] {
  return Object.freeze([choice.index, choice.kind, choice.position]);
}
