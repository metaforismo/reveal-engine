import { RECEIPT_SCHEMA, commandFingerprint } from '../../core/ledger.js';
import type { ConformanceFailure, ModuleConformanceCheck } from '../../core/module.js';
import { add, equal, multiply, rational } from '../../core/rational.js';
import { snapshotHash, toWireRational } from '../../core/snapshot.js';
import { adapterFingerprint } from './adapter.js';
import {
  COMMITMENT_VERSION,
  ROUND_BOOK_SCHEMA,
  type GameDefinition,
  type RoundContext,
} from './contracts.js';
import { makeTranscript, verifyTranscriptDetailed } from './fairness.js';
import { initialPosterior, posteriorFor, probability, quote } from './posterior.js';
import { RoundBook, type RoundBookSnapshot } from './round-book.js';
import type { ProgressiveMarketShape } from './shape.js';
import { assertDerivedEvidence } from './validation.js';

type Check = ModuleConformanceCheck<ProgressiveMarketShape>;

function bigintJson(_: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** A declarative adapter graph must be frozen before it can be trusted for replay. */
const frozenGraph: Check = {
  code: 'NOT_DEEP_FROZEN',
  description: 'Adapter declarative graph is deeply frozen',
  scope: 'definition',
  run({ definition: game }) {
    return Object.isFrozen(game) &&
      Object.isFrozen(game.outcomes) &&
      Object.isFrozen(game.priorWeights) &&
      Object.isFrozen(game.evidence) &&
      Object.isFrozen(game.pricing) &&
      Object.isFrozen(game.risk)
      ? []
      : [
          {
            code: 'NOT_DEEP_FROZEN',
            path: '$',
            message: 'Adapter declarative graph must be frozen',
          },
        ];
  },
};

/**
 * Sweeps every truth for one seed.
 *
 * Derivation must be deterministic, must return frozen data, and — critically —
 * must not leak the truth through likelihood strength or labels. An adapter
 * whose spike pattern differs by truth would let a player read the answer off
 * the evidence stream.
 */
const truthSweep: Check = {
  code: 'TRUTH_SWEEP',
  description: 'Evidence derivation is deterministic, frozen, and truth-independent in structure',
  scope: 'round',
  run({ definition: game, seedHex, roundId, seedIndex, count }) {
    const failures: ConformanceFailure[] = [];
    const context: RoundContext = { gameId: game.id, roundId, proofVersion: COMMITMENT_VERSION };
    let structural: string | undefined;
    for (let truth = 0; truth < game.outcomes.length; truth += 1) {
      const first = game.evidence.derive(seedHex, context, truth);
      const second = game.evidence.derive(seedHex, context, truth);
      assertDerivedEvidence(game, first);
      assertDerivedEvidence(game, second);
      count('truthsSwept');
      if (!Object.isFrozen(first) || first.some((event) => !Object.isFrozen(event)))
        failures.push({
          code: 'MUTABLE_DERIVATION',
          path: '$.evidence.derive',
          message: 'Derived arrays and events must be frozen',
        });
      const encodedFirst = JSON.stringify(first, bigintJson);
      if (encodedFirst !== JSON.stringify(second, bigintJson))
        failures.push({
          code: 'NON_DETERMINISTIC',
          path: '$.evidence.derive',
          message: `Seed ${seedIndex}, truth ${truth}`,
        });
      const shape = JSON.stringify(
        first.map((event) => [
          event.index,
          event.favour.toString(),
          event.other.toString(),
          event.label,
        ]),
      );
      if (structural !== undefined && shape !== structural)
        failures.push({
          code: 'TRUTH_DEPENDENT_MODEL',
          path: '$.evidence.derive',
          message: 'Likelihood schedule changes with truth',
        });
      structural = shape;
    }
    return failures;
  },
};

/** A freshly built transcript must verify against its own seed by pure re-derivation. */
const transcriptRoundTrip: Check = {
  code: 'TRANSCRIPT_ROUND_TRIP',
  description: 'Committed transcript re-derives and verifies from the revealed seed',
  scope: 'round',
  run({ definition: game, seedHex, roundId, count }) {
    const transcript = makeTranscript(seedHex, game, roundId);
    count('transcripts');
    const verification = verifyTranscriptDetailed(seedHex, game, transcript);
    return verification.ok
      ? []
      : [
          {
            code: verification.code,
            path: verification.path,
            message: verification.message,
          },
        ];
  },
};

/** Exact rational probabilities must sum to exactly one, not to one within epsilon. */
const normalizedPosterior: Check = {
  code: 'PROBABILITY_NOT_NORMALIZED',
  description: 'Posterior probabilities sum to exactly one',
  scope: 'round',
  run({ definition: game, seedHex, roundId }) {
    const transcript = makeTranscript(seedHex, game, roundId);
    const posterior = posteriorFor(game, transcript.evidence);
    const sum = game.outcomes.reduce(
      (current, _, outcome) => add(current, probability(posterior, outcome)),
      rational(0n),
    );
    return equal(sum, rational(1n))
      ? []
      : [
          {
            code: 'PROBABILITY_NOT_NORMALIZED',
            path: '$.posterior',
            message: 'Posterior probabilities do not sum to one',
          },
        ];
  },
};

/**
 * A staked, mid-round snapshot built without touching the async command API.
 *
 * Conformance checks are synchronous, but the only interesting tamper targets
 * live on a book that has actually taken a position — so the snapshot a real
 * `open()` plus `advanceFrame()` would produce is re-derived here from the same
 * primitives the book itself uses. It is not a shortcut around validation: it is
 * the input the check then hands to `RoundBook.restore()`, and
 * `tests/lifecycle-module-contract.test.ts` pins it field for field against a
 * snapshot taken from a real round, so a drift in the book's shape fails there
 * rather than quietly weakening the tamper set.
 */
export function stakedSnapshotFor(
  game: GameDefinition,
  seedHex: string,
  roundId: string,
  stake = 1_000n,
): RoundBookSnapshot {
  const transcript = makeTranscript(seedHex, game, roundId);
  const evidence = transcript.evidence.slice(0, Math.min(3, transcript.evidence.length));
  const outcome = transcript.truth;
  const posterior = posteriorFor(game, evidence);
  const fingerprint = commandFingerprint('open', [0, outcome, stake]);
  const base = {
    schema: ROUND_BOOK_SCHEMA,
    adapter: {
      id: game.id,
      version: game.adapterVersion,
      fingerprint: adapterFingerprint(game),
    },
    frameRevision: evidence.length,
    ledgerRevision: 1,
    posterior: { weights: posterior.weights.map(String), total: String(posterior.total) },
    evidence: evidence.map((event) => ({
      ...event,
      favour: String(event.favour),
      other: String(event.other),
    })),
    position: {
      outcome,
      contingentPayout: toWireRational(
        multiply(rational(stake), quote(game, initialPosterior(game), outcome, true, 0).multiplier),
      ),
      stake: String(stake),
      capBasisStake: String(stake),
      entryCount: 1,
      openedAtFrameRevision: 0,
    },
    entryCount: 1,
    capBasisStake: String(stake),
    liquidBalance: '0',
    terminal: false,
    receipts: [
      {
        fingerprint,
        receipt: {
          schema: RECEIPT_SCHEMA,
          idempotencyKey: 'open',
          commandFingerprint: fingerprint,
          action: 'open',
          ledgerRevision: 1,
          frameRevision: 0,
          debited: String(stake),
          credited: '0',
          balanceDelta: String(-stake),
          capped: false,
        },
      },
    ],
  };
  return Object.freeze({ ...base, snapshotHash: snapshotHash(base) }) as RoundBookSnapshot;
}

/**
 * `defineLifecycleModule()` cannot tell a `restore()` that re-validates from one
 * that returns a fresh book or trusts its input — both satisfy the type.
 * Conformance can, and the contract asks every module for this check.
 *
 * The tamper set deliberately includes the two position fields no other snapshot
 * field implies: the outcome the player took (pinned by the open receipt's
 * fingerprint) and the claim it bought (pinned by the price replayed at the
 * frame it was opened at). A restore that reads either straight out of the
 * snapshot settles a losing position as a winner, or a small claim as a large
 * one, under a perfectly recomputed checksum.
 */
const snapshotIsRevalidated: Check = {
  code: 'SNAPSHOT_NOT_REVALIDATED',
  description: 'restore() round-trips a staked snapshot and rejects re-sealed tampering',
  scope: 'round',
  run({ definition: game, seedHex, roundId, count }) {
    const failures: ConformanceFailure[] = [];
    const reject = (path: string, message: string): void => {
      failures.push({ code: 'SNAPSHOT_NOT_REVALIDATED', path, message });
    };
    const snapshot = stakedSnapshotFor(game, seedHex, roundId);
    count('snapshots');
    try {
      const restored = RoundBook.restore(game, JSON.stringify(snapshot));
      if (JSON.stringify(restored.snapshot()) !== JSON.stringify(snapshot))
        reject('$.snapshot', 'Restored book does not re-serialize identically');
    } catch (error) {
      reject('$.snapshot', `Restore rejected an honest snapshot: ${String(error)}`);
    }

    const reseal = (value: Record<string, unknown>): string =>
      JSON.stringify({
        ...value,
        snapshotHash: snapshotHash({ ...value, snapshotHash: undefined }),
      });
    const position = snapshot.position as NonNullable<RoundBookSnapshot['position']>;
    const tampers: readonly (readonly [string, string])[] = [
      [
        '$.position.outcome',
        reseal({
          ...snapshot,
          position: { ...position, outcome: (position.outcome + 1) % game.outcomes.length },
        }),
      ],
      [
        '$.position.contingentPayout',
        reseal({
          ...snapshot,
          position: {
            ...position,
            contingentPayout: {
              ...position.contingentPayout,
              numerator: String(BigInt(position.contingentPayout.numerator) * 7n),
            },
          },
        }),
      ],
      ['$.liquidBalance', reseal({ ...snapshot, liquidBalance: '999999' })],
      ['$.ledgerRevision', reseal({ ...snapshot, ledgerRevision: 7 })],
      ['$.receipts', reseal({ ...snapshot, receipts: [] })],
      [
        '$.adapter.fingerprint',
        reseal({ ...snapshot, adapter: { ...snapshot.adapter, fingerprint: '0'.repeat(64) } }),
      ],
      // Not re-sealed: the checksum still has to catch plain corruption.
      ['$.snapshotHash', JSON.stringify({ ...snapshot, snapshotHash: '0'.repeat(64) })],
    ];
    for (const [path, tampered] of tampers) {
      count('snapshotTampers');
      try {
        RoundBook.restore(game, tampered);
        reject(path, 'Restore accepted a tampered snapshot');
      } catch {
        // Expected: a tampered snapshot must not restore.
      }
    }
    return failures;
  },
};

export const PROGRESSIVE_MARKET_CHECKS: readonly Check[] = Object.freeze([
  frozenGraph,
  truthSweep,
  transcriptRoundTrip,
  normalizedPosterior,
  snapshotIsRevalidated,
]);
