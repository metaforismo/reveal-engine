import type { GameDefinition, Transcript } from '../src/modules/progressive-market/contracts.js';
import { makeTranscript } from '../src/modules/progressive-market/fairness.js';
import { initialPosterior } from '../src/modules/progressive-market/posterior.js';
import { RoundBook } from '../src/modules/progressive-market/round-book.js';

export function seed(index: number): string {
  return index.toString(16).padStart(64, '0');
}

export async function completedBook(
  game: GameDefinition,
  seedHex = seed(1),
  roundId = 'round-1',
): Promise<{ book: RoundBook; transcript: Transcript }> {
  const transcript = makeTranscript(seedHex, game, roundId);
  const book = new RoundBook(game, initialPosterior(game));
  for (const event of transcript.evidence) await book.advanceFrame(event);
  return { book, transcript };
}

export async function advanceAll(book: RoundBook, transcript: Transcript): Promise<void> {
  for (const event of transcript.evidence.slice(book.frame.revision))
    await book.advanceFrame(event);
}
