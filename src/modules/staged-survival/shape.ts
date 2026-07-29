import type { LifecycleShape } from '../../core/module.js';
import type { SurvivalBook } from './book.js';
import type {
  SurvivalChoice,
  SurvivalClaimRef,
  SurvivalDefinition,
  SurvivalStep,
  SurvivalTranscript,
  SurvivalTruth,
} from './contracts.js';

/** The lifecycle type bag for `staged-survival`. */
export interface StagedSurvivalShape extends LifecycleShape {
  readonly definition: SurvivalDefinition;
  readonly truth: SurvivalTruth;
  readonly step: SurvivalStep;
  readonly choice: SurvivalChoice;
  readonly claim: SurvivalClaimRef;
  readonly transcript: SurvivalTranscript;
  readonly book: SurvivalBook;
}
