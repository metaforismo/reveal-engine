import type { LifecycleShape } from '../../core/module.js';
import type {
  CardsClaim,
  CardsTranscript,
  Deal,
  PlayerChoice,
  RevealStep,
  SequentialCardsDefinition,
} from './contracts.js';
import type { CardsBook } from './round-book.js';

/**
 * Type bag for the sequential-cards module.
 *
 * The truth is a dealt vector plus the reveal selectors sealed with it, a step
 * is one card turning face up, a choice is a backing decision logged before the
 * reveals resolve, and a claim is either a set of board positions or a side
 * market over the objective rank.
 */
export interface SequentialCardsShape extends LifecycleShape {
  readonly definition: SequentialCardsDefinition;
  readonly truth: Deal;
  readonly step: RevealStep;
  readonly choice: PlayerChoice;
  readonly claim: CardsClaim;
  readonly transcript: CardsTranscript;
  readonly book: CardsBook;
}
