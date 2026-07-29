import { commandFingerprint, RECEIPT_SCHEMA } from '../../core/ledger.js';
import type { ConformanceFailure, ModuleConformanceCheck } from '../../core/module.js';
import { add, compare, equal, multiply, rational } from '../../core/rational.js';
import { sha256Hex } from '../../core/random.js';
import { snapshotHash } from '../../core/snapshot.js';
import { encodeFields } from '../../internal/canonical.js';
import {
  betParameters,
  betWins,
  claimSignature,
  enumerateInstances,
  enumerateOrders,
} from './bets.js';
import {
  PERMUTATION_BET_CODES,
  PERMUTATION_BOOK_SCHEMA,
  type PermutationBet,
  type PermutationDefinition,
  type PermutationOrder,
} from './contracts.js';
import { permutationFingerprint } from './definition.js';
import {
  derivePermutationOrder,
  derivePermutationSteps,
  makePermutationTranscript,
  verifyPermutationTranscript,
} from './derivation.js';
import { fairMultiplier, freshProbability, linePayout, price } from './pricing.js';
import { PermutationBook, type PermutationBookSnapshot } from './round-book.js';
import type { PermutationShape } from './shape.js';
import { deserializePermutationTranscript, permutationTranscriptToWire } from './transcript.js';

type Check = ModuleConformanceCheck<PermutationShape>;

function failure(code: string, path: string, message: string): ConformanceFailure {
  return { code, path, message };
}

/** A declarative definition must be frozen before it can be trusted for replay. */
const frozenDefinition: Check = {
  code: 'NOT_DEEP_FROZEN',
  description: 'Definition graph, item list, and paytable are deeply frozen',
  scope: 'definition',
  run({ definition }) {
    const frozen =
      Object.isFrozen(definition) &&
      Object.isFrozen(definition.items) &&
      Object.isFrozen(definition.paytable) &&
      Object.isFrozen(definition.rtp) &&
      PERMUTATION_BET_CODES.every((code) => Object.isFrozen(definition.paytable[code]));
    return frozen
      ? []
      : [failure('NOT_DEEP_FROZEN', '$', 'Definition graph must be deeply frozen')];
  },
};

/**
 * Applies the descending Fisher-Yates schedule to an explicit draw vector.
 *
 * Written here, independently of `core/random.ts`, so the bijection below is a
 * property of the *algorithm* rather than a tautology about the implementation
 * that produces it.
 */
function shuffleFromDraws(size: number, draws: readonly number[]): readonly number[] {
  const order = Array.from({ length: size }, (_unused, index) => index);
  for (let position = size - 1, draw = 0; position > 0; position -= 1, draw += 1) {
    const pick = draws[draw] as number;
    const swapped = order[position] as number;
    order[position] = order[pick] as number;
    order[pick] = swapped;
  }
  return order;
}

/** Every legal draw vector: `draws[t]` ranges over `[0, size - t)`. */
function enumerateDrawVectors(size: number): readonly (readonly number[])[] {
  const vectors: (readonly number[])[] = [];
  const current: number[] = [];
  const walk = (position: number): void => {
    if (position <= 0) {
      vectors.push([...current]);
      return;
    }
    for (let pick = 0; pick <= position; pick += 1) {
      current.push(pick);
      walk(position - 1);
      current.pop();
    }
  };
  walk(size - 1);
  return vectors;
}

/**
 * The uniformity argument's first half, proved exhaustively rather than cited.
 *
 * Core's sampler is unbiased for every modulus — that is core's own claim and
 * core's own test. What is *this* module's claim is that feeding independent
 * uniform draws through the shuffle yields a uniform element of `S_n`, and that
 * holds exactly when the map from draw vectors to permutations is a bijection.
 * There are `n * (n-1) * ... * 2 = n!` draw vectors and `n!` permutations, so
 * the check is: every permutation is produced, and produced exactly once. This
 * enumerates all of them. It is a proof, not a statistical test.
 */
const shuffleIsBijective: Check = {
  code: 'SHUFFLE_NOT_BIJECTIVE',
  description: 'Every Fisher-Yates draw vector maps onto a distinct permutation, exhaustively',
  scope: 'definition',
  run({ definition, count }) {
    const size = definition.items.length;
    const produced = new Set<string>();
    for (const draws of enumerateDrawVectors(size)) {
      count('drawVectors');
      const key = shuffleFromDraws(size, draws).join(',');
      if (produced.has(key))
        return [
          failure(
            'SHUFFLE_NOT_BIJECTIVE',
            '$.truth.derive',
            `Draw vector [${draws.join(',')}] duplicates permutation ${key}`,
          ),
        ];
      produced.add(key);
    }
    const expected = enumerateOrders(size).length;
    return produced.size === expected
      ? []
      : [
          failure(
            'SHUFFLE_NOT_BIJECTIVE',
            '$.truth.derive',
            `Shuffle produced ${produced.size} of ${expected} permutations`,
          ),
        ];
  },
};

/**
 * A step schedule must not leak the truth through its structure.
 *
 * Sweeps **every** truth, not a sample of them, and requires the reveal count
 * and the position sequence to be identical for all of them: only the items may
 * differ. A schedule whose shape varied with the answer would let a player read
 * the answer off the shape.
 */
const stepStructureIsTruthIndependent: Check = {
  code: 'STEP_STRUCTURE_LEAKS_TRUTH',
  description: 'Reveal count and position sequence are identical for every possible truth',
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    let structure: string | undefined;
    for (const order of enumerateOrders(definition.items.length)) {
      const steps = derivePermutationSteps(definition, order);
      count('truthsSwept');
      if (!Object.isFrozen(steps) || steps.some((step) => !Object.isFrozen(step)))
        failures.push(
          failure('MUTABLE_DERIVATION', '$.steps.derive', 'Derived steps must be frozen'),
        );
      const shape = steps.map((step) => step.position).join(',');
      if (structure !== undefined && shape !== structure)
        failures.push(
          failure(
            'TRUTH_DEPENDENT_MODEL',
            '$.steps.derive',
            'Reveal schedule changes shape with the truth',
          ),
        );
      structure = shape;
      if (
        steps.length !== definition.items.length - 1 ||
        steps.some((step, index) => step.item !== order[index])
      )
        failures.push(
          failure(
            'STEP_STRUCTURE_LEAKS_TRUTH',
            '$.steps.derive',
            'Reveals do not settle the order they were derived from',
          ),
        );
      if (failures.length > 0) break;
    }
    return failures;
  },
};

/** The derived truth is a permutation, deterministically, and it comes back frozen. */
const truthIsPermutation: Check = {
  code: 'TRUTH_IS_PERMUTATION',
  description: 'Derived truth is a deterministic, frozen permutation of the declared items',
  scope: 'round',
  run({ definition, seedHex, roundId, count }) {
    const first = derivePermutationOrder(seedHex, definition, roundId);
    const second = derivePermutationOrder(seedHex, definition, roundId);
    count('truths');
    const failures: ConformanceFailure[] = [];
    if (!Object.isFrozen(first))
      failures.push(failure('MUTABLE_DERIVATION', '$.truth.derive', 'Truth must be frozen'));
    if (first.join(',') !== second.join(','))
      failures.push(
        failure('NON_DETERMINISTIC', '$.truth.derive', 'Truth derivation is not deterministic'),
      );
    const sorted = [...first].sort((left, right) => left - right);
    if (first.length !== definition.items.length || sorted.some((item, index) => item !== index))
      failures.push(
        failure('TRUTH_IS_PERMUTATION', '$.truth', 'Truth is not a permutation of the items'),
      );
    return failures;
  },
};

/** A freshly built transcript verifies against its own seed and survives the wire. */
const transcriptRoundTrip: Check = {
  code: 'TRANSCRIPT_ROUND_TRIP',
  description: 'Committed transcript re-derives, verifies, and round-trips through the codec',
  scope: 'round',
  run({ definition, seedHex, roundId, count }) {
    const failures: ConformanceFailure[] = [];
    const transcript = makePermutationTranscript(seedHex, definition, roundId);
    count('transcripts');
    const verification = verifyPermutationTranscript(seedHex, definition, transcript);
    if (!verification.ok)
      failures.push(failure(verification.code, verification.path, verification.message));

    const wire = permutationTranscriptToWire(transcript);
    const decoded = deserializePermutationTranscript(JSON.stringify(wire));
    if (JSON.stringify(permutationTranscriptToWire(decoded)) !== JSON.stringify(wire))
      failures.push(
        failure('TRANSCRIPT_ROUND_TRIP', '$.transcript', 'Transcript does not survive its codec'),
      );

    // A verifier that accepts a rewritten proof is worse than no verifier, so
    // each re-derivation phase is exercised with a mutation only that phase can
    // catch. Both structural mutations stay *well formed* on purpose — a
    // rotation is still a permutation, a swap is still a distinct-item prefix —
    // so the codec waves them through and the comparison has to do the work.
    const tampers: readonly (readonly [string, unknown, string])[] = [
      ['order', { ...wire, order: [...wire.order.slice(1), wire.order[0]] }, 'TRANSCRIPT_MISMATCH'],
      [
        'reveals',
        {
          ...wire,
          reveals: wire.reveals.map((step, index) =>
            index < 2 ? { ...step, item: wire.reveals[1 - index]?.item ?? step.item } : step,
          ),
        },
        'TRANSCRIPT_MISMATCH',
      ],
      ['commitment', { ...wire, commitment: '0'.repeat(64) }, 'COMMITMENT_MISMATCH'],
      [
        'fingerprint',
        { ...wire, definition: { ...wire.definition, fingerprint: '0'.repeat(64) } },
        'DEFINITION_MISMATCH',
      ],
    ];
    for (const [label, tampered, expected] of tampers) {
      count('transcriptTampers');
      const result = verifyPermutationTranscript(seedHex, definition, tampered);
      if (result.ok || result.code !== expected)
        failures.push(
          failure(
            'TRANSCRIPT_ROUND_TRIP',
            `$.${label}`,
            `Tampered ${label} verified as ${result.ok ? 'valid' : result.code}, expected ${expected}`,
          ),
        );
    }
    return failures;
  },
};

/**
 * Prices are a probability measure, exactly, at every step prefix.
 *
 * For any position, exactly one item settles into it, so the `slot` prices over
 * that position must sum to exactly `1` — including a position already revealed,
 * where the distribution is a point mass. Summing to one *within an epsilon* is
 * the failure mode this repository exists to avoid, so the comparison is on
 * exact rationals.
 */
const pricesAreNormalised: Check = {
  code: 'PRICE_NOT_NORMALISED',
  description: 'Slot prices over each position sum to exactly one at every step prefix',
  scope: 'round',
  run({ definition, seedHex, roundId, count }) {
    const failures: ConformanceFailure[] = [];
    const transcript = makePermutationTranscript(seedHex, definition, roundId);
    const size = definition.items.length;
    for (let prefix = 0; prefix <= transcript.reveals.length; prefix += 1) {
      const steps = transcript.reveals.slice(0, prefix);
      for (let position = 0; position < size; position += 1) {
        count('priceSweeps');
        const total = definition.items.reduce(
          (sum, _label, item) =>
            add(sum, price(definition, steps, { code: 'slot', item, position })),
          rational(0n),
        );
        if (!equal(total, rational(1n)))
          failures.push(
            failure(
              'PRICE_NOT_NORMALISED',
              '$.steps.price',
              `Slot prices for position ${position} summed to ${total.numerator}/${total.denominator} after ${prefix} reveals`,
            ),
          );
      }
    }
    return failures;
  },
};

/**
 * The paytable prices the declared RTP exactly, pays in whole units, and does
 * not hide behind the cap.
 *
 * Three separate obligations, and each one is a way a paytable can be quietly
 * dishonest: a multiplier that misses `rho / p` gives that chip a different
 * house edge from every other chip; a multiplier whose denominator does not
 * divide the stake quantum makes the floor at the credit boundary a real
 * truncation the player pays for; and a cap that a single winning line can reach
 * means the advertised RTP is not the RTP.
 */
const pricingIdentityHolds: Check = {
  code: 'PRICING_IDENTITY_BROKEN',
  description: 'Every multiplier prices the declared RTP exactly, pays exactly, and clears the cap',
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    for (const code of PERMUTATION_BET_CODES) {
      const instance = enumerateInstances(definition, code)[0];
      if (instance === undefined) {
        failures.push(
          failure('PRICING_IDENTITY_BROKEN', `$.paytable.${code}`, 'Family has no instances'),
        );
        continue;
      }
      count('pricedFamilies');
      const probability = freshProbability(definition, instance);
      const multiplier = definition.paytable[code];
      if (!equal(multiply(probability, multiplier), definition.rtp))
        failures.push(
          failure(
            'PRICING_IDENTITY_BROKEN',
            `$.paytable.${code}`,
            `probability x multiplier is not the declared RTP (expected ${fairMultiplier(definition.rtp, probability).numerator}/${fairMultiplier(definition.rtp, probability).denominator})`,
          ),
        );
      if (definition.stakeQuantum % multiplier.denominator !== 0n)
        failures.push(
          failure(
            'INEXACT_PAYOUT',
            `$.paytable.${code}`,
            'Multiplier denominator does not divide the stake quantum',
          ),
        );
      // The largest legal line must still pay a whole number of minor units.
      // Caught rather than thrown: a conformance check reports, and letting this
      // escape would abort the remaining families and hide their verdicts.
      try {
        linePayout(definition, code, definition.maxLineStake);
      } catch {
        failures.push(
          failure(
            'INEXACT_PAYOUT',
            `$.paytable.${code}`,
            'The largest legal line does not pay a whole number of minor units',
          ),
        );
      }
      if (compare(multiplier, rational(definition.maxWinMultiple)) >= 0)
        failures.push(
          failure(
            'CAP_BINDS',
            `$.paytable.${code}`,
            'A single winning line can reach the round cap, so the advertised RTP is not the RTP',
          ),
        );
    }
    return failures;
  },
};

/**
 * One published multiplier per family is only honest if the family is uniform.
 *
 * Every instance of a family must share one exact probability, or the paytable
 * has a cheap corner and a trap instance and the RTP is a family average rather
 * than a promise. Checked instance by instance across the whole catalogue, plus
 * the complementary statement for `full`: its `n!` instances partition the order
 * space, so their prices sum to exactly one.
 */
const familiesAreHomogeneous: Check = {
  code: 'FAMILY_NOT_HOMOGENEOUS',
  description: 'Every instance of a family shares one exact probability',
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    for (const code of PERMUTATION_BET_CODES) {
      let reference: string | undefined;
      for (const instance of enumerateInstances(definition, code)) {
        count('instances');
        const probability = freshProbability(definition, instance);
        const rendered = `${probability.numerator}/${probability.denominator}`;
        if (reference !== undefined && rendered !== reference) {
          failures.push(
            failure(
              'FAMILY_NOT_HOMOGENEOUS',
              `$.paytable.${code}`,
              `Instances price at ${reference} and ${rendered}`,
            ),
          );
          break;
        }
        reference = rendered;
      }
    }
    const fullTotal = enumerateInstances(definition, 'full').reduce(
      (sum, instance) => add(sum, freshProbability(definition, instance)),
      rational(0n),
    );
    if (!equal(fullTotal, rational(1n)))
      failures.push(
        failure(
          'FULL_ORDER_NOT_NORMALISED',
          '$.steps.price',
          `Full-order prices summed to ${fullTotal.numerator}/${fullTotal.denominator}`,
        ),
      );
    return failures;
  },
};

/**
 * The cheap claim identity agrees with behaviour, over the whole order space.
 *
 * The book compares claims by a digest of their canonical assignment form, which
 * is `O(n)`; what it *means* to be the same claim is winning on the same set of
 * orders, which is `O(n!)`. This check is what stops those two from being
 * different things. It enumerates every order and every instance outside the
 * `full` family, groups instances by win set and by signature, and requires the
 * two groupings to be identical — so an alias the book would miss, or a
 * collision the book would invent, both fail here.
 *
 * `full` is handled by argument rather than by a second `O((n!)^2)` sweep, and
 * the argument is checked rather than asserted: each `full` instance wins on
 * exactly the one order it names, the map from instance to that order is a
 * bijection onto `S_n`, and every other family wins on `(n-1)! > 1` orders for
 * every supported `n`, so no `full` claim can alias anything.
 */
const claimIdentityIsBehavioural: Check = {
  code: 'CLAIM_IDENTITY_NOT_BEHAVIOURAL',
  description: 'Claim signatures collide exactly when win sets collide, over the whole order space',
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    const orders = enumerateOrders(definition.items.length);
    const byWinSet = new Map<string, string[]>();
    const bySignature = new Map<string, string[]>();
    const label = (bet: PermutationBet): string => `${bet.code}(${betParameters(bet).join(',')})`;
    const group = (groups: Map<string, string[]>, key: string, name: string): void => {
      const bucket = groups.get(key);
      if (bucket === undefined) groups.set(key, [name]);
      else bucket.push(name);
    };

    for (const code of PERMUTATION_BET_CODES) {
      if (code === 'full') continue;
      for (const instance of enumerateInstances(definition, code)) {
        count('aliasInstances');
        const bitmap = orders
          .map((order) => (betWins(definition, instance, order) ? '1' : '0'))
          .join('');
        const wins = bitmap.split('').filter((bit) => bit === '1').length;
        if (wins <= 1 || wins >= orders.length)
          failures.push(
            failure(
              'DEGENERATE_FAMILY',
              `$.paytable.${code}`,
              `${label(instance)} wins on ${wins} of ${orders.length} orders`,
            ),
          );
        group(
          byWinSet,
          sha256Hex(encodeFields(['permutation-winset-v1', bitmap])),
          label(instance),
        );
        group(bySignature, claimSignature(definition, instance), label(instance));
      }
    }
    const grouping = (groups: Map<string, string[]>): string =>
      JSON.stringify([...groups.values()].map((names) => [...names].sort()).sort());
    if (grouping(byWinSet) !== grouping(bySignature))
      failures.push(
        failure(
          'CLAIM_IDENTITY_NOT_BEHAVIOURAL',
          '$.book.claims',
          'Signature grouping differs from win-set grouping',
        ),
      );

    // `full`: one order each, all distinct, and never colliding with a family
    // that wins on more than one order.
    const fullTargets = new Set<string>();
    const fullSignatures = new Set<string>();
    for (const instance of enumerateInstances(definition, 'full')) {
      count('aliasInstances');
      const order = (instance as { readonly order: PermutationOrder }).order;
      if (!betWins(definition, instance, order))
        failures.push(
          failure(
            'CLAIM_IDENTITY_NOT_BEHAVIOURAL',
            '$.paytable.full',
            'A full-order bet does not win on its own order',
          ),
        );
      fullTargets.add(order.join(','));
      fullSignatures.add(claimSignature(definition, instance));
    }
    if (fullTargets.size !== orders.length || fullSignatures.size !== orders.length)
      failures.push(
        failure(
          'CLAIM_IDENTITY_NOT_BEHAVIOURAL',
          '$.paytable.full',
          'Full-order instances do not map one-to-one onto the order space',
        ),
      );
    for (const signature of fullSignatures)
      if (bySignature.has(signature))
        failures.push(
          failure(
            'CLAIM_IDENTITY_NOT_BEHAVIOURAL',
            '$.paytable.full',
            'A full-order claim shares a signature with a wider claim',
          ),
        );
    return failures;
  },
};

/**
 * Settlement and pricing are the same statement, told twice.
 *
 * A bet either wins on the settled order or it does not, and after the whole
 * schedule has been revealed its price is a certainty either way. If those two
 * ever disagree, one of them is paying the wrong player: a claim priced at zero
 * that settles as a winner, or a claim sold as live that cannot pay. The check
 * requires `betWins <=> price === 1` and `!betWins <=> price === 0` over the
 * whole catalogue outside `full`, plus the round's own winning and a losing
 * `full` instance.
 */
const settlementMatchesPrice: Check = {
  code: 'SETTLEMENT_DISAGREES_WITH_PRICE',
  description: 'A bet wins exactly when its fully-revealed price is exactly one',
  scope: 'round',
  run({ definition, seedHex, roundId, count }) {
    const failures: ConformanceFailure[] = [];
    const order = derivePermutationOrder(seedHex, definition, roundId);
    const steps = derivePermutationSteps(definition, order);
    // A reversed order always differs from its source for `n >= 2`, because the
    // first and last items are distinct — so this is a genuine losing instance.
    const instances: PermutationBet[] = [
      ...PERMUTATION_BET_CODES.filter((code) => code !== 'full').flatMap((code) => [
        ...enumerateInstances(definition, code),
      ]),
      { code: 'full', order },
      { code: 'full', order: Object.freeze([...order].reverse()) },
    ];
    for (const bet of instances) {
      count('settledInstances');
      const settled = betWins(definition, bet, order);
      const quoted = price(definition, steps, bet);
      const certain = equal(quoted, rational(settled ? 1n : 0n));
      if (!certain)
        failures.push(
          failure(
            'SETTLEMENT_DISAGREES_WITH_PRICE',
            '$.steps.price',
            `${bet.code} settled as ${settled ? 'win' : 'loss'} but priced ${quoted.numerator}/${quoted.denominator}`,
          ),
        );
    }
    return failures;
  },
};

/**
 * A staked, non-terminal snapshot rebuilt without touching the async book API.
 *
 * Conformance checks are synchronous and the book's command API is not, so the
 * snapshot a real pair of `place()` calls would produce is re-derived here from
 * the same primitives. It is not a shortcut around validation — it is the input
 * the check then hands to `PermutationBook.restore()` — and a contract test pins
 * it field for field against a snapshot taken from a real round, so a drift in
 * the book's shape fails loudly instead of quietly reducing the tamper set to
 * something `restore()` would have rejected anyway.
 */
export function stakedSnapshotFor(
  definition: PermutationDefinition,
  seedHex: string,
  roundId: string,
): PermutationBookSnapshot {
  const order = derivePermutationOrder(seedHex, definition, roundId);
  // One quantum above the minimum where the definition allows it, so the two
  // lines carry different stakes and a claim/receipt mix-up cannot pass by
  // coincidence — but never past the per-line ceiling, which a definition with a
  // single legal stake would otherwise trip.
  const second =
    definition.minLineStake + definition.stakeQuantum > definition.maxLineStake
      ? definition.minLineStake
      : definition.minLineStake + definition.stakeQuantum;
  const bets: readonly (readonly [string, PermutationBet, bigint])[] = [
    ['place-first', { code: 'first', item: order[0] as number }, definition.minLineStake],
    [
      'place-stack',
      { code: 'stack', before: order[0] as number, after: order[1] as number },
      second,
    ],
  ];
  // The round this staked book is bound to. Derived from the same seed the order
  // came from, because that is what an operator publishes before betting opens:
  // a binding invented independently of the draw would make the snapshot
  // describe a state the book cannot reach.
  const commitment = makePermutationTranscript(seedHex, definition, roundId).commitment;
  const base = {
    schema: PERMUTATION_BOOK_SCHEMA,
    definition: {
      id: definition.id,
      version: definition.version,
      fingerprint: permutationFingerprint(definition),
    },
    binding: { roundId, commitment },
    terminal: false,
    ledgerRevision: bets.length,
    stepRevision: 0,
    liquidBalance: '0',
    capBasisStake: String(bets.reduce((total, [, , stake]) => total + stake, 0n)),
    claims: bets.map(([key, bet, stake]) => ({
      key,
      code: bet.code,
      parameters: [...betParameters(bet)],
      stake: String(stake),
    })),
    settlement: null,
    receipts: bets.map(([key, bet, stake], index) => {
      // Includes the round: a `place` is a claim on a specific draw, so the
      // command's identity carries the binding. See `placeFingerprint`.
      const fingerprint = commandFingerprint('place', [
        roundId,
        commitment,
        bet.code,
        ...betParameters(bet),
        stake,
      ]);
      return {
        fingerprint,
        receipt: {
          schema: RECEIPT_SCHEMA,
          idempotencyKey: key,
          commandFingerprint: fingerprint,
          action: 'place',
          ledgerRevision: index + 1,
          frameRevision: 0,
          debited: String(stake),
          credited: '0',
          balanceDelta: String(-stake),
          capped: false,
        },
      };
    }),
  };
  return Object.freeze({
    ...base,
    snapshotHash: snapshotHash(base),
  }) as unknown as PermutationBookSnapshot;
}

/**
 * `defineLifecycleModule()` cannot tell a `restore()` that re-validates from one
 * that returns a fresh book — both satisfy the type. Conformance can.
 *
 * Every mutation is **re-sealed** before it is restored, so what is under test
 * is the semantic validation rather than the checksum: anyone able to rewrite a
 * field can recompute a hash over it. The tamper set deliberately includes the
 * two money-bearing claim fields, because those are the ones a restore that
 * trusts its snapshot gets wrong in the player's or the operator's favour.
 */
const snapshotIsRevalidated: Check = {
  code: 'SNAPSHOT_NOT_REVALIDATED',
  description: 'restore() round-trips a staked snapshot and rejects re-sealed tampering',
  scope: 'round',
  run({ definition, seedHex, roundId, count }) {
    const failures: ConformanceFailure[] = [];
    const reject = (path: string, message: string): void => {
      failures.push(failure('SNAPSHOT_NOT_REVALIDATED', path, message));
    };
    const snapshot = stakedSnapshotFor(definition, seedHex, roundId);
    count('snapshots');
    try {
      const restored = PermutationBook.restore(definition, JSON.stringify(snapshot));
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
    const claims = snapshot.claims as unknown as Record<string, unknown>[];
    const rewrite = (index: number, patch: Record<string, unknown>): Record<string, unknown>[] =>
      claims.map((claim, position) => (position === index ? { ...claim, ...patch } : claim));
    // Shifted rather than fixed: a hard-coded item index would silently become a
    // no-op on whichever seed happens to draw it, and a tamper case that does
    // not tamper is a check that passes for the wrong reason.
    const otherItem = [((snapshot.claims[0]?.parameters[0] ?? 0) + 1) % definition.items.length];
    const tampers: readonly (readonly [string, string])[] = [
      // The stake decides the payout, and the receipt fingerprint pins it.
      ['$.claims[0].stake', reseal({ ...snapshot, claims: rewrite(0, { stake: '999999' }) })],
      // So does which bet was actually placed.
      [
        '$.claims[0].parameters',
        reseal({ ...snapshot, claims: rewrite(0, { parameters: otherItem }) }),
      ],
      ['$.claims[0].code', reseal({ ...snapshot, claims: rewrite(0, { code: 'last' }) })],
      ['$.claims', reseal({ ...snapshot, claims: [] })],
      ['$.liquidBalance', reseal({ ...snapshot, liquidBalance: '999999' })],
      ['$.capBasisStake', reseal({ ...snapshot, capBasisStake: '999999' })],
      ['$.terminal', reseal({ ...snapshot, terminal: true })],
      ['$.ledgerRevision', reseal({ ...snapshot, ledgerRevision: 7 })],
      ['$.receipts', reseal({ ...snapshot, receipts: [] })],
      // A receipt field that moves no balance is still a field the restored
      // audit record must not be free to invent: `place` mints `capped: false`
      // unconditionally.
      [
        '$.receipts[0].receipt.capped',
        reseal({
          ...snapshot,
          receipts: snapshot.receipts.map((entry, position) =>
            position === 0 ? { ...entry, receipt: { ...entry.receipt, capped: true } } : entry,
          ),
        }),
      ],
      // The round the book was bound to before it took a bet. Dropping it, or
      // pointing it at another round, must not restore a book that then settles
      // against whatever proof arrives.
      ['$.binding', reseal({ ...snapshot, binding: null })],
      [
        '$.binding.commitment',
        reseal({
          ...snapshot,
          binding: { ...(snapshot.binding as { roundId: string }), commitment: '0'.repeat(64) },
        }),
      ],
      [
        '$.definition.fingerprint',
        reseal({
          ...snapshot,
          definition: { ...snapshot.definition, fingerprint: '0'.repeat(64) },
        }),
      ],
      // Not re-sealed: the checksum still has to catch plain corruption.
      ['$.snapshotHash', JSON.stringify({ ...snapshot, snapshotHash: '0'.repeat(64) })],
    ];
    for (const [path, tampered] of tampers) {
      count('snapshotTampers');
      try {
        PermutationBook.restore(definition, tampered);
        reject(path, 'Restore accepted a tampered snapshot');
      } catch {
        // Expected: a tampered snapshot must not restore.
      }
    }
    return failures;
  },
};

export const PERMUTATION_CHECKS: readonly Check[] = Object.freeze([
  frozenDefinition,
  shuffleIsBijective,
  stepStructureIsTruthIndependent,
  pricingIdentityHolds,
  familiesAreHomogeneous,
  claimIdentityIsBehavioural,
  truthIsPermutation,
  transcriptRoundTrip,
  pricesAreNormalised,
  settlementMatchesPrice,
  snapshotIsRevalidated,
]);
