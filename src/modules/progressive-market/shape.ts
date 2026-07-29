import type { LifecycleShape } from '../../core/module.js';
import type { EvidenceEvent, GameDefinition, Transcript } from './contracts.js';
import type { RoundBook } from './round-book.js';

/**
 * Type bag for the progressive market.
 *
 * The truth is a scalar outcome index, a step is one Bayesian evidence event,
 * and there are no logged player choices: every step is derivable from the seed
 * alone the moment the commitment is published.
 */
export interface ProgressiveMarketShape extends LifecycleShape {
  readonly definition: GameDefinition;
  readonly truth: number;
  readonly step: EvidenceEvent;
  readonly choice: never;
  readonly transcript: Transcript;
  readonly book: RoundBook;
}
