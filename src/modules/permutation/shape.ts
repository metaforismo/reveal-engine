import type { LifecycleShape } from '../../core/module.js';
import type {
  PermutationBet,
  PermutationDefinition,
  PermutationOrder,
  PermutationStep,
  PermutationTranscript,
} from './contracts.js';
import type { PermutationBook } from './round-book.js';

/**
 * Type bag binding the lifecycle contract's slots to this module's domain.
 *
 * `choice` is `never`: a round logs no player decisions. The ticket is the only
 * thing a player chooses and it is not an input to the derivation, so the truth
 * is a pure function of the seed and nothing a player does can move it.
 */
export interface PermutationShape extends LifecycleShape {
  readonly definition: PermutationDefinition;
  readonly truth: PermutationOrder;
  readonly step: PermutationStep;
  readonly choice: never;
  readonly claim: PermutationBet;
  readonly transcript: PermutationTranscript;
  readonly book: PermutationBook;
}
