import { createHash } from 'node:crypto';
import { fail } from '../api/errors.js';
import { ENGINE_LIMITS } from '../api/limits.js';
import { encodeFields, type CanonicalField } from '../internal/canonical.js';
import { payableWithinCap, type Payable } from './payments.js';
import type { Rational } from './rational.js';
import {
  assertSnapshotKeys,
  assertSnapshotRecord,
  assertSnapshotRevision,
  assertWireHex,
  parseWireBigInt,
  parseWireSignedBigInt,
} from './snapshot.js';
import { assertBoundedBigInt, isRecord } from './validation.js';

export const RECEIPT_SCHEMA = 'reveal-engine/receipt-v1' as const;
const COMMAND_DOMAIN = 'round-command-v1' as const;

/**
 * Immutable money-movement record.
 *
 * `action` is module-defined: the progressive market uses open/sell/settle, a
 * staged-survival module will use pick/bank/resolve. `frameRevision` keeps its
 * historical wire name and means "the step revision this command was fenced to".
 */
export interface Receipt<Action extends string = string> {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly idempotencyKey: string;
  readonly commandFingerprint: string;
  readonly action: Action;
  readonly ledgerRevision: number;
  readonly frameRevision: number;
  readonly debited: bigint;
  readonly credited: bigint;
  readonly balanceDelta: bigint;
  readonly capped: boolean;
}

export interface StoredReceipt<Action extends string = string> {
  readonly fingerprint: string;
  readonly receipt: Receipt<Action>;
}

export interface WireReceipt {
  readonly schema: string;
  readonly idempotencyKey: string;
  readonly commandFingerprint: string;
  readonly action: string;
  readonly ledgerRevision: number;
  readonly frameRevision: number;
  readonly debited: string;
  readonly credited: string;
  readonly balanceDelta: string;
  readonly capped: boolean;
}

export const RECEIPT_WIRE_KEYS = Object.freeze([
  'schema',
  'idempotencyKey',
  'commandFingerprint',
  'action',
  'ledgerRevision',
  'frameRevision',
  'debited',
  'credited',
  'balanceDelta',
  'capped',
]);

/** Binds an idempotency key to the exact command payload it first executed. */
export function commandFingerprint(action: string, fields: readonly CanonicalField[]): string {
  return createHash('sha256')
    .update(encodeFields([COMMAND_DOMAIN, action, ...fields]))
    .digest('hex');
}

export function assertIdempotencyKey(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > ENGINE_LIMITS.maxIdempotencyKeyBytes
  )
    fail('IDEMPOTENCY_CONFLICT', 'Invalid idempotency key', '$.idempotencyKey');
}

export function toWireReceipt(receipt: Receipt): WireReceipt {
  return Object.freeze({
    ...receipt,
    debited: String(receipt.debited),
    credited: String(receipt.credited),
    balanceDelta: String(receipt.balanceDelta),
  });
}

/**
 * Decodes one receipt from attacker-controlled snapshot data.
 *
 * Shape is checked before any field is read: a module calling this directly on
 * wire input gets a typed `INVALID_SNAPSHOT`, never a `TypeError`.
 */
export function fromWireReceipt<Action extends string = string>(
  value: WireReceipt,
  actions: readonly Action[],
): Receipt<Action> {
  const record = assertSnapshotRecord(value, '$.receipt');
  assertSnapshotKeys(record, RECEIPT_WIRE_KEYS, '$.receipt');
  if (!Array.isArray(actions)) fail('INVALID_SNAPSHOT', 'Expected an action list', '$.actions');
  for (const key of ['schema', 'action', 'commandFingerprint', 'idempotencyKey'] as const)
    if (typeof record[key] !== 'string')
      fail('INVALID_SNAPSHOT', 'Receipt field is not a string', `$.receipt.${key}`);
  if (typeof record.capped !== 'boolean')
    fail('INVALID_SNAPSHOT', 'Receipt capped flag is not a boolean', '$.receipt.capped');
  const receipt = Object.freeze({
    ...value,
    debited: parseWireBigInt(value.debited, '$.receipt.debited', true),
    credited: parseWireBigInt(value.credited, '$.receipt.credited', true),
    balanceDelta: parseWireSignedBigInt(value.balanceDelta, '$.receipt.balanceDelta'),
  });
  if (
    receipt.schema !== RECEIPT_SCHEMA ||
    !(actions as readonly string[]).includes(receipt.action) ||
    receipt.balanceDelta !== receipt.credited - receipt.debited ||
    !/^[0-9a-f]{64}$/u.test(receipt.commandFingerprint) ||
    typeof receipt.idempotencyKey !== 'string' ||
    receipt.idempotencyKey.length === 0 ||
    Buffer.byteLength(receipt.idempotencyKey, 'utf8') > ENGINE_LIMITS.maxIdempotencyKeyBytes
  )
    fail('INVALID_SNAPSHOT', 'Snapshot receipt accounting is invalid');
  assertSnapshotRevision(receipt.ledgerRevision, '$.receipt.ledgerRevision');
  assertSnapshotRevision(receipt.frameRevision, '$.receipt.frameRevision');
  return receipt as Receipt<Action>;
}

export interface CommandLedgerOptions {
  readonly maxWinMultiple: bigint;
  readonly maxReceipts?: number;
}

/**
 * Where a stake's money comes from.
 *
 * `external` is new money entering the round from the player's wallet. It grows
 * the round's cap basis, because the ceiling is a multiple of what the player
 * actually risked — a book holding several independently funded positions has a
 * larger legitimate ceiling than a book holding one.
 *
 * `recycled` is value the player already won inside this round and is putting
 * back at risk. It is debited from the liquid balance and must never grow the
 * basis: if a win could finance a larger ceiling, the cap would compound and the
 * round's maximum exposure would be unbounded.
 */
export type StakeFunding = 'external' | 'recycled';

/**
 * Round-scoped command ledger: serialization, idempotency, receipts, and the
 * cap-chain accounting every lifecycle module needs.
 *
 * The ledger deliberately knows nothing about positions, outcomes, or evidence.
 * A module owns its state machine and calls the ledger for the parts that must
 * behave identically in every game: one command at a time, an idempotency key
 * bound to its exact payload, a receipt minted before state mutates, and a
 * credit that can never take the round above its cap ceiling.
 *
 * There is exactly one ledger per round, however many positions the round
 * holds. Per-position ledgers would fork both the command serialization order
 * and the dense ledger-revision chain, which the snapshot format and the
 * idempotency guarantee both depend on.
 */
export class CommandLedger {
  readonly #maxWinMultiple: bigint;
  readonly #maxReceipts: number;
  #ledgerRevision = 0;
  #liquidBalance = 0n;
  #capBasisStake: bigint | undefined;
  #receipts = new Map<string, StoredReceipt>();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: CommandLedgerOptions) {
    if (!isRecord(options)) fail('INVALID_ADAPTER', 'Ledger requires an options object', '$');
    if (typeof options.maxWinMultiple !== 'bigint' || options.maxWinMultiple <= 0n)
      fail('INVALID_ADAPTER', 'Ledger requires a positive max win multiple', '$.maxWinMultiple');
    const maxReceipts = options.maxReceipts ?? ENGINE_LIMITS.maxReceipts;
    if (!Number.isSafeInteger(maxReceipts) || maxReceipts <= 0)
      fail('INVALID_ADAPTER', 'Ledger receipt budget must be a positive integer', '$.maxReceipts');
    this.#maxWinMultiple = options.maxWinMultiple;
    this.#maxReceipts = maxReceipts;
  }

  get ledgerRevision(): number {
    return this.#ledgerRevision;
  }
  get liquidBalance(): bigint {
    return this.#liquidBalance;
  }
  get capBasisStake(): bigint | undefined {
    return this.#capBasisStake;
  }
  get receiptCount(): number {
    return this.#receipts.size;
  }
  get maxWinMultiple(): bigint {
    return this.#maxWinMultiple;
  }

  entries(): readonly StoredReceipt[] {
    return Object.freeze([...this.#receipts.values()]);
  }

  /** Serializes every command so a duplicate can never interleave with its original. */
  async serial<T>(operation: () => T): Promise<T> {
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
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

  /**
   * Runs one command under its idempotency key.
   *
   * An exact retry replays the stored receipt. The same key with a different
   * payload or action is a conflict, never a silently wrong receipt. `operation`
   * must compute its receipt with `mint()` before mutating module state, so a
   * rejection leaves the round untouched.
   */
  async execute<Action extends string = string>(
    key: string,
    fingerprint: string,
    operation: () => Receipt<Action>,
  ): Promise<Receipt<Action>> {
    return this.serial(() => {
      assertIdempotencyKey(key);
      const existing = this.#receipts.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          fail(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key was used for a different command',
            '$.idempotencyKey',
          );
        return existing.receipt as Receipt<Action>;
      }
      if (this.#receipts.size >= this.#maxReceipts)
        fail('IDEMPOTENCY_CONFLICT', 'Receipt limit reached');
      const receipt = operation();
      this.#ledgerRevision = receipt.ledgerRevision;
      this.#receipts.set(key, Object.freeze({ fingerprint, receipt }));
      return receipt;
    });
  }

  mint<Action extends string>(
    key: string,
    fingerprint: string,
    action: Action,
    stepRevision: number,
    debited: bigint,
    credited: bigint,
    capped: boolean,
  ): Receipt<Action> {
    return Object.freeze({
      schema: RECEIPT_SCHEMA,
      idempotencyKey: key,
      commandFingerprint: fingerprint,
      action,
      ledgerRevision: this.#ledgerRevision + 1,
      frameRevision: stepRevision,
      debited,
      credited,
      balanceDelta: credited - debited,
      capped,
    });
  }

  /**
   * Registers a stake against the round's cap chain and returns the new basis.
   *
   * Externally funded stakes accumulate, so a multi-position book gets a ceiling
   * proportional to everything the player risked; recycled stakes are debited
   * from liquid winnings and leave the ceiling exactly where it was. The
   * round-wide invariant both halves preserve is
   * `liquidBalance <= capBasisStake * maxWinMultiple`, i.e. a player can never
   * walk away with more than `maxWinMultiple` times the money they brought in.
   */
  fundStake(amount: bigint, funding: StakeFunding): bigint {
    assertBoundedBigInt(amount, '$.stake', true);
    if (funding === 'recycled') {
      if (this.#capBasisStake === undefined)
        fail('CLAIM_REJECTED', 'A recycled stake requires an existing cap basis', '$.stake');
      if (amount > this.#liquidBalance)
        fail('CLAIM_REJECTED', 'A recycled stake must be self-financing', '$.stake');
      this.#liquidBalance -= amount;
      return this.#capBasisStake;
    }
    if (funding !== 'external') fail('CLAIM_REJECTED', 'Unknown stake funding source', '$.funding');
    const basis = (this.#capBasisStake ?? 0n) + amount;
    assertBoundedBigInt(basis, '$.capBasisStake', true);
    this.#capBasisStake = basis;
    return basis;
  }

  /**
   * Credit an exact rational claim, floored and bounded by the remaining ceiling.
   *
   * A round that has taken no stake has no ceiling, so there is nothing to
   * credit against: that is a module state-machine bug and fails loudly rather
   * than silently paying zero against a positive theoretical claim.
   */
  creditWithinCap(theoretical: Rational): Payable {
    if (this.#capBasisStake === undefined)
      fail('CLAIM_REJECTED', 'Cannot credit a round that has taken no stake', '$.capBasisStake');
    return payableWithinCap(
      theoretical,
      this.#capBasisStake,
      this.#maxWinMultiple,
      this.#liquidBalance,
    );
  }

  applyCredit(amount: bigint): void {
    if (amount < 0n) fail('INVALID_RATIONAL', 'Credit must be non-negative', '$.credited');
    this.#liquidBalance += amount;
  }

  /**
   * Rebuilds ledger state from a snapshot.
   *
   * Generic invariants are enforced here: canonical ledger ordering, stored
   * fingerprints matching the receipt they index, and no receipt fenced to a
   * step the round never reached. `visit` receives every receipt in ledger order
   * so the module can replay its own state machine on top.
   */
  install<Action extends string>(
    stored: readonly StoredReceipt<Action>[],
    maxStepRevision: number,
    visit: (receipt: Receipt<Action>, index: number) => void,
  ): void {
    if (stored.length > this.#maxReceipts)
      fail('INVALID_SNAPSHOT', 'Snapshot receipt count exceeds the ledger budget');
    const ordered = [...stored].sort(
      (left, right) => left.receipt.ledgerRevision - right.receipt.ledgerRevision,
    );
    for (const [index, entry] of ordered.entries()) {
      assertWireHex(entry.fingerprint, `$.receipts[${index}].fingerprint`);
      if (
        entry.receipt.ledgerRevision !== index + 1 ||
        entry.receipt.frameRevision > maxStepRevision ||
        entry.fingerprint !== entry.receipt.commandFingerprint
      )
        fail('INVALID_SNAPSHOT', 'Receipt revisions are not canonical');
      visit(entry.receipt, index);
      this.#receipts.set(entry.receipt.idempotencyKey, Object.freeze({ ...entry }));
    }
  }

  /** Installs the reconstructed money state and rejects any accounting that does not close. */
  restoreBalances(state: {
    readonly ledgerRevision: number;
    readonly liquidBalance: bigint;
    readonly capBasisStake: bigint | undefined;
  }): void {
    if (state.ledgerRevision !== this.#receipts.size)
      fail('INVALID_SNAPSHOT', 'Ledger revision does not match the receipt log');
    if (state.liquidBalance < 0n)
      fail('INVALID_SNAPSHOT', 'Snapshot accounting does not conserve liquid value');
    if (
      state.capBasisStake !== undefined &&
      state.liquidBalance > state.capBasisStake * this.#maxWinMultiple
    )
      fail('INVALID_SNAPSHOT', 'Snapshot exceeds the chain cap');
    this.#ledgerRevision = state.ledgerRevision;
    this.#liquidBalance = state.liquidBalance;
    this.#capBasisStake = state.capBasisStake;
  }
}
