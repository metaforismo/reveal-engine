import type { OpenRequest, Receipt, RoundBook, SellRequest } from '../protocol/round-book.js';
/** Sketch of an RGS adapter: replace this process-local map with one DB transaction and durable receipt store. */
export class RgsExample {
  constructor(private readonly books: Map<string, RoundBook>) {}
  open(roundId: string, request: OpenRequest): Promise<Receipt> {
    return this.require(roundId).open(request);
  }
  sell(roundId: string, request: SellRequest): Promise<Receipt> {
    return this.require(roundId).sell(request);
  }
  settle(roundId: string, key: string, truth: number): Promise<Receipt> {
    return this.require(roundId).settle(key, truth);
  }
  private require(roundId: string): RoundBook {
    const book = this.books.get(roundId);
    if (!book) throw new Error('UNKNOWN_ROUND');
    return book;
  }
}
