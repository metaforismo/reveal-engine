import { fairValue, quote } from '../core/posterior.js';
import type { GameDefinition, Posterior } from '../core/contracts.js';
import { payable } from '../core/payments.js';
import { rational } from '../core/rational.js';

export interface Position {
  readonly outcome: number;
  readonly contingentPayout: bigint;
  readonly originalStake: bigint;
  readonly entryCount: number;
}
export interface Receipt {
  readonly idempotencyKey: string;
  readonly action: 'open' | 'sell' | 'settle';
  readonly revision: number;
  readonly credited: bigint;
  readonly capped: boolean;
}
export interface OpenRequest {
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly outcome: number;
  readonly stake: bigint;
}
export interface SellRequest {
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}
export class RoundBook {
  #position: Position | undefined;
  #entryCount = 0;
  #revision = 0;
  #terminal = false;
  #receipts = new Map<string, Receipt>();
  #tail: Promise<void> = Promise.resolve();
  constructor(
    readonly game: GameDefinition,
    readonly posterior: Posterior,
  ) {}
  get revision(): number {
    return this.#revision;
  }
  get terminal(): boolean {
    return this.#terminal;
  }
  /** Read-only state for an integration's snapshot serializer; never client authority. */
  get position(): Position | undefined {
    return this.#position;
  }
  async open(request: OpenRequest): Promise<Receipt> {
    return this.#serial(() => {
      const old = this.#receipts.get(request.idempotencyKey);
      if (old) return old;
      this.#assertFrame(request.expectedRevision);
      if (this.#terminal || this.#position || request.stake <= 0n) throw new Error('OPEN_REJECTED');
      const first = this.#entryCount === 0;
      const multiplier = quote(
        this.game,
        this.posterior,
        request.outcome,
        first,
        this.#revision,
      ).multiplier;
      const contingentPayout = (request.stake * multiplier.numerator) / multiplier.denominator;
      this.#position = Object.freeze({
        outcome: request.outcome,
        contingentPayout,
        originalStake: request.stake,
        entryCount: this.#entryCount + 1,
      });
      this.#entryCount += 1;
      return this.#record(request.idempotencyKey, 'open', 0n, false);
    });
  }
  async sell(request: SellRequest): Promise<Receipt> {
    return this.#serial(() => {
      const old = this.#receipts.get(request.idempotencyKey);
      if (old) return old;
      this.#assertFrame(request.expectedRevision);
      if (this.#terminal || !this.#position) throw new Error('SELL_REJECTED');
      const p = this.#position;
      const theoretical = fairValue(
        p.contingentPayout,
        this.posterior,
        p.outcome,
        this.game.pricing.liquidationSpread,
      );
      const result = payable(theoretical, p.originalStake, this.game.risk.maxWinMultiple);
      this.#position = undefined;
      return this.#record(request.idempotencyKey, 'sell', result.credited, result.capped);
    });
  }
  async settle(idempotencyKey: string, truth: number): Promise<Receipt> {
    return this.#serial(() => {
      const old = this.#receipts.get(idempotencyKey);
      if (old) return old;
      if (this.#terminal) throw new Error('SETTLE_REJECTED');
      this.#terminal = true;
      const p = this.#position;
      this.#position = undefined;
      const theoretical = p && p.outcome === truth ? rational(p.contingentPayout) : rational(0n);
      const result = p
        ? payable(theoretical, p.originalStake, this.game.risk.maxWinMultiple)
        : { credited: 0n, capped: false };
      return this.#record(idempotencyKey, 'settle', result.credited, result.capped);
    });
  }
  #assertFrame(expected: number): void {
    if (expected !== this.#revision) throw new Error('STALE_FRAME');
  }
  #record(key: string, action: Receipt['action'], credited: bigint, capped: boolean): Receipt {
    const receipt = Object.freeze({
      idempotencyKey: key,
      action,
      revision: ++this.#revision,
      credited,
      capped,
    });
    this.#receipts.set(key, receipt);
    return receipt;
  }
  async #serial<T>(operation: () => T): Promise<T> {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    const prior = this.#tail;
    this.#tail = gate;
    await prior;
    try {
      return operation();
    } finally {
      resolve();
    }
  }
}
