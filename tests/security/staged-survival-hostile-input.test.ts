import { describe, expect, it } from 'vitest';
import { RevealEngineError } from '../../src/api/errors.js';
import { ENGINE_LIMITS } from '../../src/api/limits.js';
import { rational } from '../../src/core/rational.js';
import { snapshotHash } from '../../src/core/snapshot.js';
import {
  SurvivalBook,
  belief,
  deriveSteps,
  deriveTruth,
  deserializeTranscript,
  fiveRunnerReference,
  lanePartition,
  laneSizes,
  makeTranscript,
  price,
  resolveStage,
  roundRefId,
  serializeTranscript,
  stagedSurvival,
  survivalFingerprint,
  transcriptToWire,
  type SurvivalStep,
} from '../../src/modules/staged-survival/index.js';
import { seed } from '../helpers.js';

const definition = fiveRunnerReference;
const SEED = seed(5);
const ROUND_ID = roundRefId({ roundId: 'hostile', clientEntropy: 'de'.repeat(32) });

const goodTranscript = makeTranscript(SEED, definition, ROUND_ID, [
  { contractId: 'wide', banked: [] },
  { contractId: 'wide', banked: [] },
]);
const goodWire = transcriptToWire(goodTranscript) as Record<string, unknown>;

/** Recomputes the checksum so a mutation is judged on its merits, not on the hash. */
const reseal = (snapshot: Record<string, unknown>): Record<string, unknown> => ({
  ...snapshot,
  snapshotHash: snapshotHash({ ...snapshot, snapshotHash: undefined }),
});

async function stakedBook(): Promise<SurvivalBook> {
  const book = new SurvivalBook(definition);
  for (let entity = 0; entity < definition.entities; entity += 1)
    await book.enter(`enter-${entity}`, entity, 1_000n);
  await book.choose('choose-0', 'wide');
  await book.resolve(goodTranscript.steps[0] as SurvivalStep);
  if (book.live.length > 1) await book.bank('bank-0', [book.live[0] as number]);
  return book;
}

describe('staged-survival: the transcript wire boundary', () => {
  it('accepts the honest payload and its serialized form', () => {
    expect(deserializeTranscript(goodWire)).toEqual(goodTranscript);
    expect(deserializeTranscript(serializeTranscript(goodTranscript))).toEqual(goodTranscript);
  });

  it('fails closed on an unknown schema and never on a message', () => {
    for (const schema of ['staged-survival/transcript-v2', 'reveal-engine/transcript-v2', 'x'])
      expect(() => deserializeTranscript({ ...goodWire, schema })).toThrowError(
        expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }),
      );
    expect(() => deserializeTranscript({ ...goodWire, schema: 42 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_TRANSCRIPT' }),
    );
  });

  it('rejects every structurally hostile payload with a typed error and a path', () => {
    const cases: readonly [string, unknown][] = [
      ['not an object', 'nope'],
      ['null', null],
      ['array', []],
      ['invalid JSON string', '{'],
      ['unknown key', { ...goodWire, extra: 1 }],
      [
        'missing key',
        (() => {
          const { commitment: _commitment, ...rest } = goodWire;
          return rest;
        })(),
      ],
      [
        'uppercase commitment',
        { ...goodWire, commitment: (goodWire.commitment as string).toUpperCase() },
      ],
      ['short digest', { ...goodWire, tapeDigest: 'ab' }],
      ['non-hex entropy', { ...goodWire, clientEntropy: 'zz'.repeat(32) }],
      ['entropy of the wrong width', { ...goodWire, clientEntropy: 'de'.repeat(16) }],
      ['empty round id', { ...goodWire, roundId: '' }],
      ['choices not an array', { ...goodWire, choices: {} }],
      ['steps not an array', { ...goodWire, steps: {} }],
      [
        'more steps than decisions',
        { ...goodWire, choices: (goodWire.choices as unknown[]).slice(0, 1) },
      ],
      [
        'choice with an unknown key',
        {
          ...goodWire,
          choices: (goodWire.choices as object[]).map((choice) => ({ ...choice, weight: 1 })),
        },
      ],
      [
        'descending banked list',
        {
          ...goodWire,
          choices: (goodWire.choices as object[]).map((choice, index) =>
            index === 0 ? { ...choice, banked: [2, 1] } : choice,
          ),
        },
      ],
      [
        'duplicate survivor',
        {
          ...goodWire,
          steps: (goodWire.steps as { survivors: number[] }[]).map((step, index) =>
            index === 0 ? { ...step, survivors: [0, 0, 1] } : step,
          ),
        },
      ],
      [
        'fractional entity index',
        {
          ...goodWire,
          steps: (goodWire.steps as { survivors: number[] }[]).map((step, index) =>
            index === 0 ? { ...step, survivors: [0.5] } : step,
          ),
        },
      ],
      [
        'entity index outside module limits',
        {
          ...goodWire,
          steps: (goodWire.steps as { survivors: number[] }[]).map((step, index) =>
            index === 0 ? { ...step, survivors: [999] } : step,
          ),
        },
      ],
      [
        'step index out of position',
        {
          ...goodWire,
          steps: (goodWire.steps as { index: number }[]).map((step) => ({ ...step, index: 7 })),
        },
      ],
      [
        'lane collapse flag is not a boolean',
        {
          ...goodWire,
          steps: (goodWire.steps as { lanes: object[] }[]).map((step, index) =>
            index === 0
              ? { ...step, lanes: step.lanes.map((lane) => ({ ...lane, collapsed: 'yes' })) }
              : step,
          ),
        },
      ],
      [
        'oversized choice log',
        {
          ...goodWire,
          choices: Array.from({ length: ENGINE_LIMITS.maxLoggedChoices + 1 }, () => ({
            contractId: 'wide',
            banked: [],
          })),
        },
      ],
    ];
    for (const [label, payload] of cases) {
      let thrown: unknown;
      try {
        deserializeTranscript(payload);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, label).toBeInstanceOf(RevealEngineError);
      const failure = thrown as RevealEngineError;
      expect(['INVALID_TRANSCRIPT', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_VERSION'], label).toContain(
        failure.code,
      );
      expect(failure.path, label).toMatch(/^\$/u);
    }
  });

  it('does not read an inherited key off a prototype-polluted payload', () => {
    const polluted = Object.assign(Object.create({ commitment: goodWire.commitment }), {
      ...goodWire,
    }) as Record<string, unknown>;
    delete polluted.commitment;
    expect(() => deserializeTranscript(polluted)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TRANSCRIPT' }),
    );
  });

  it('bounds the payload by bytes before doing any structural work', () => {
    const huge = `"${'a'.repeat(ENGINE_LIMITS.maxTranscriptBytes + 1)}"`;
    expect(() => deserializeTranscript(huge)).toThrowError(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    );
  });
});

describe('staged-survival: the verifier never leaks', () => {
  it('returns a typed failure for every hostile input rather than throwing', () => {
    const cases: readonly [string, unknown, string][] = [
      ['garbage', { schema: 'staged-survival/transcript-v1' }, 'INVALID_TRANSCRIPT'],
      ['a string', 'not a transcript', 'INVALID_TRANSCRIPT'],
      [
        'an old schema',
        { ...goodWire, schema: 'staged-survival/transcript-v0' },
        'UNSUPPORTED_VERSION',
      ],
      ['a foreign definition id', { ...goodWire, definitionId: 'other' }, 'DEFINITION_MISMATCH'],
      [
        'a foreign definition version',
        { ...goodWire, definitionVersion: '9.9.9' },
        'DEFINITION_MISMATCH',
      ],
      [
        'a rewritten fingerprint',
        { ...goodWire, definitionFingerprint: `${'0'.repeat(63)}1` },
        'DEFINITION_MISMATCH',
      ],
      [
        'a rewritten seed commitment',
        { ...goodWire, seedCommitment: `${'0'.repeat(63)}1` },
        'COMMITMENT_MISMATCH',
      ],
      [
        'a rewritten entropy',
        { ...goodWire, clientEntropy: 'ff'.repeat(32) },
        'TRANSCRIPT_MISMATCH',
      ],
      ['a rewritten round id', { ...goodWire, roundId: 'other-round' }, 'COMMITMENT_MISMATCH'],
      [
        'a rewritten tape digest',
        { ...goodWire, tapeDigest: `${'0'.repeat(63)}1` },
        'TRANSCRIPT_MISMATCH',
      ],
      [
        'a rewritten commitment',
        { ...goodWire, commitment: `${'0'.repeat(63)}1` },
        'COMMITMENT_MISMATCH',
      ],
      [
        // Still a playable log — `narrow` is offered to any field — so the
        // replay succeeds and disagrees with the recorded steps.
        'a rewritten contract that stays playable',
        {
          ...goodWire,
          choices: (goodWire.choices as { contractId: string }[]).map((choice, index) =>
            index === 1 ? { ...choice, contractId: 'narrow' } : choice,
          ),
        },
        'TRANSCRIPT_MISMATCH',
      ],
      [
        'a rewritten survivor list',
        {
          ...goodWire,
          steps: (goodWire.steps as { survivors: number[]; failed: number[] }[]).map(
            (step, index) =>
              index === 0
                ? { ...step, survivors: [...step.survivors].slice(1), failed: [0] }
                : step,
          ),
        },
        'TRANSCRIPT_MISMATCH',
      ],
      [
        'a rewritten lane collapse bit',
        {
          ...goodWire,
          steps: (goodWire.steps as { lanes: { collapsed: boolean }[] }[]).map((step, index) =>
            index === 0
              ? {
                  ...step,
                  lanes: step.lanes.map((lane) => ({ ...lane, collapsed: !lane.collapsed })),
                }
              : step,
          ),
        },
        'TRANSCRIPT_MISMATCH',
      ],
      [
        // A log that names a contract the menu does not have is not a
        // disagreement about randomness — it is a transcript that could never
        // have been played, and it is reported as one.
        'an unknown contract in the log',
        {
          ...goodWire,
          choices: (goodWire.choices as object[]).map((choice, index) =>
            index === 0 ? { ...choice, contractId: 'ghost' } : choice,
          ),
        },
        'INVALID_TRANSCRIPT',
      ],
      [
        'a decision the shrinking menu could not have offered',
        {
          ...goodWire,
          choices: (goodWire.choices as object[]).map((choice, index) =>
            index === 0 ? { ...choice, contractId: 'wide', banked: [0, 1, 2] } : choice,
          ),
        },
        'INVALID_TRANSCRIPT',
      ],
    ];
    for (const [label, payload, code] of cases) {
      const result = stagedSurvival.verify(SEED, definition, payload);
      expect(result.ok, label).toBe(false);
      expect(result, label).toMatchObject({ code });
    }
    expect(stagedSurvival.verify(SEED, definition, goodWire)).toMatchObject({ ok: true });
  });

  it('classifies a malformed seed and a malformed definition without throwing', () => {
    expect(stagedSurvival.verify('not-a-seed', definition, goodWire).ok).toBe(false);
    expect(
      stagedSurvival.verify(SEED, { ...definition, entities: 0 } as never, goodWire),
    ).toMatchObject({ ok: false, code: 'DERIVATION_FAILED' });
  });
});

describe('staged-survival: the snapshot boundary', () => {
  it('rejects a re-sealed rewrite of every money-bearing field', async () => {
    const book = await stakedBook();
    const snapshot = JSON.parse(JSON.stringify(book.snapshot())) as Record<string, unknown>;
    expect(SurvivalBook.restore(definition, snapshot).liquidBalance).toBe(book.liquidBalance);

    const rewrites: readonly [string, Record<string, unknown>][] = [
      [
        'definition id',
        { ...snapshot, definition: { id: 'other', fingerprint: survivalFingerprint(definition) } },
      ],
      [
        'definition fingerprint',
        { ...snapshot, definition: { id: definition.id, fingerprint: `${'0'.repeat(63)}1` } },
      ],
      ['stage revision', { ...snapshot, stageRevision: 2 }],
      ['ledger revision', { ...snapshot, ledgerRevision: 99 }],
      ['terminal flag', { ...snapshot, terminal: true }],
      ['liquid balance', { ...snapshot, liquidBalance: String(book.liquidBalance + 1n) }],
      ['cap basis', { ...snapshot, capBasisStake: '999999' }],
      [
        'entry stake',
        {
          ...snapshot,
          entries: (snapshot.entries as { entity: number; stake: string }[]).map((entry, index) =>
            index === 0 ? { ...entry, stake: '999999' } : entry,
          ),
        },
      ],
      [
        'entry entity',
        {
          ...snapshot,
          entries: (snapshot.entries as { entity: number }[]).map((entry, index) =>
            index === 0 ? { ...entry, entity: 4 } : entry,
          ),
        },
      ],
      [
        'decision contract',
        {
          ...snapshot,
          choices: (snapshot.choices as { contractId: string }[]).map((choice) => ({
            ...choice,
            contractId: 'narrow',
          })),
        },
      ],
      [
        'step survivors',
        {
          ...snapshot,
          steps: (snapshot.steps as { survivors: number[]; failed: number[] }[]).map((step) => ({
            ...step,
            survivors: [...step.failed],
            failed: [...step.survivors],
          })),
        },
      ],
      [
        'lane geometry',
        {
          ...snapshot,
          steps: (snapshot.steps as { lanes: { entities: number[] }[] }[]).map((step) => ({
            ...step,
            lanes: [{ entities: [0, 1, 2, 3, 4], collapsed: false }],
          })),
        },
      ],
      [
        'bank stage',
        {
          ...snapshot,
          banks: (snapshot.banks as { stage: number }[]).map((entry) => ({ ...entry, stage: 0 })),
        },
      ],
      [
        'banked entity',
        {
          ...snapshot,
          banks: (snapshot.banks as { entities: number[] }[]).map((entry) => ({
            ...entry,
            entities: [(entry.entities[0] as number) === 4 ? 3 : 4],
          })),
        },
      ],
      ['pending banked set', { ...snapshot, pendingBanked: [] }],
      [
        'settlement commitment on a live round',
        { ...snapshot, settlementCommitment: `${'0'.repeat(63)}1` },
      ],
      [
        'receipt credit',
        {
          ...snapshot,
          receipts: (snapshot.receipts as { receipt: { credited: string } }[]).map((entry) =>
            entry.receipt.credited === '0'
              ? entry
              : { ...entry, receipt: { ...entry.receipt, credited: '1' } },
          ),
        },
      ],
    ];
    for (const [label, rewritten] of rewrites) {
      let thrown: unknown;
      try {
        SurvivalBook.restore(definition, reseal(rewritten));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, label).toBeInstanceOf(RevealEngineError);
      expect(['INVALID_SNAPSHOT', 'DEFINITION_MISMATCH', 'INVALID_CHOICE'], label).toContain(
        (thrown as RevealEngineError).code,
      );
    }
  });

  it('refuses a withdrawal set the live path could not have produced', async () => {
    // Regression. `restore()` reconciled the withdrawn set as a *set union* of
    // every decision's banked list plus `pendingBanked`, so an entity present in
    // both collapsed to one element and passed the count check. `choose()`
    // clears the pending subset and `bank()` is closed while a decision is
    // pending, so the live path can never produce that state — and a round
    // restored from it can never be settled: the next decision re-folds the
    // stale entity, and `deriveSteps` then refuses it as a banked entity that
    // was not running. It costs availability rather than value, but `restore()`
    // is advertised as re-validating rather than trusting.
    const book = await stakedBook();
    const pending = (book.snapshot() as { pendingBanked: readonly number[] }).pendingBanked;
    expect(pending.length).toBeGreaterThan(0);

    await book.choose('choose-1', book.menu()[0] as string);
    const committed = JSON.parse(JSON.stringify(book.snapshot())) as Record<string, unknown>;
    // The decision absorbed the subset: it is in the choice, and nowhere else.
    expect(committed.pendingBanked).toEqual([]);
    expect((committed.choices as { banked: number[] }[])[1]?.banked).toEqual([...pending]);
    expect(SurvivalBook.restore(definition, committed).liquidBalance).toBe(book.liquidBalance);
    expect(() =>
      SurvivalBook.restore(definition, reseal({ ...committed, pendingBanked: [...pending] })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));

    // Same forgery once the decision has resolved. Here there is no pending
    // decision at all, so only the disjointness of the two sources rejects it —
    // and this is the shape the old set union accepted outright.
    const second = makeTranscript(SEED, definition, ROUND_ID, book.choices);
    await book.resolve(second.steps[1] as SurvivalStep);
    const resolved = JSON.parse(JSON.stringify(book.snapshot())) as Record<string, unknown>;
    expect(resolved.pendingBanked).toEqual([]);
    expect(SurvivalBook.restore(definition, resolved).liquidBalance).toBe(book.liquidBalance);
    expect(() =>
      SurvivalBook.restore(definition, reseal({ ...resolved, pendingBanked: [...pending] })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  it('refuses a credited bank over a field that was never fully funded', async () => {
    // `bank()` refuses until every entity is funded, so a bank receipt implies a
    // complete entry list exactly as a logged decision does. The forgery below
    // strips four entries, their four `enter` receipts and the cap basis
    // together, so the surviving entry, its receipt and the bank credit all
    // still reconcile with each other; it is refused for what it is rather than
    // for an arithmetic mismatch. The ledger's own revision numbering refuses it
    // independently, which is why the path is asserted and not only the code.
    const book = new SurvivalBook(definition);
    for (let entity = 0; entity < definition.entities; entity += 1)
      await book.enter(`fund-${entity}`, entity, 1_000n);
    await book.bank('bank-first', [0]);
    const snapshot = JSON.parse(JSON.stringify(book.snapshot())) as Record<string, unknown>;
    expect(snapshot.choices).toEqual([]);
    expect(SurvivalBook.restore(definition, snapshot).liquidBalance).toBe(955n);
    const entries = snapshot.entries as { entity: number; stake: string }[];
    const receipts = snapshot.receipts as { receipt: { action: string } }[];
    expect(() =>
      SurvivalBook.restore(
        definition,
        reseal({
          ...snapshot,
          entries: entries.slice(0, 1),
          receipts: receipts.filter(
            (entry, index) => entry.receipt.action !== 'enter' || index === 0,
          ),
          capBasisStake: '1000',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT', path: '$.entries' }));
  });

  it('refuses a restored entry stake too wide for the round arithmetic', async () => {
    // The snapshot codec bounds a wire BigInt by the engine's 4096-bit limit,
    // which is far wider than any stake `enter()` accepts. A restored entry that
    // exploited the gap overflowed in `replayValues()` and surfaced as
    // `INVALID_RATIONAL` — an arithmetic failure where a rejected snapshot
    // belongs, and from a code path that had already built half a book.
    const book = await stakedBook();
    const snapshot = JSON.parse(JSON.stringify(book.snapshot())) as Record<string, unknown>;
    const entries = snapshot.entries as { entity: number; stake: string }[];
    for (const stake of [1n << 64n, 1n << 4_090n]) {
      let thrown: unknown;
      try {
        SurvivalBook.restore(
          definition,
          reseal({
            ...snapshot,
            entries: entries.map((entry, index) =>
              index === 0 ? { ...entry, stake: String(stake) } : entry,
            ),
          }),
        );
      } catch (error) {
        thrown = error;
      }
      expect((thrown as RevealEngineError).code, String(stake)).toBe('INVALID_SNAPSHOT');
    }
  });

  it('still catches plain corruption through the checksum', async () => {
    const book = await stakedBook();
    const snapshot = JSON.parse(JSON.stringify(book.snapshot())) as Record<string, unknown>;
    // Deliberately NOT re-sealed: this case exists to prove the checksum still
    // catches a corrupted payload, and it stands in for no merits-based check.
    expect(() =>
      SurvivalBook.restore(definition, { ...snapshot, liquidBalance: '1' }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  it('rejects a structurally hostile snapshot with a typed error', async () => {
    const book = await stakedBook();
    const snapshot = JSON.parse(JSON.stringify(book.snapshot())) as Record<string, unknown>;
    const cases: readonly [string, unknown][] = [
      ['not an object', 'nope'],
      ['invalid JSON', '{'],
      ['unknown key', reseal({ ...snapshot, extra: 1 })],
      [
        'missing key',
        (() => {
          const { banks: _banks, ...rest } = snapshot;
          return reseal(rest);
        })(),
      ],
      ['wrong schema', reseal({ ...snapshot, schema: 'staged-survival/book-v2' })],
      ['negative stage revision', reseal({ ...snapshot, stageRevision: -1 })],
      ['non-canonical balance', reseal({ ...snapshot, liquidBalance: '007' })],
      ['bank with no entities', reseal({ ...snapshot, banks: [{ stage: 1, entities: [] }] })],
      ['receipts not an array', reseal({ ...snapshot, receipts: {} })],
      ['choices not an array', reseal({ ...snapshot, choices: 'wide' })],
    ];
    for (const [label, payload] of cases) {
      let thrown: unknown;
      try {
        SurvivalBook.restore(definition, payload as object);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, label).toBeInstanceOf(RevealEngineError);
      expect(['INVALID_SNAPSHOT', 'PAYLOAD_TOO_LARGE'], label).toContain(
        (thrown as RevealEngineError).code,
      );
    }
  });
});

describe('staged-survival: hostile arguments to the pricing surface', () => {
  it('refuses a malformed definition rather than pricing against it', () => {
    const truth = deriveTruth(SEED, definition, ROUND_ID);
    const steps = deriveSteps(definition, truth, [{ contractId: 'wide', banked: [] }]);
    for (const broken of [
      { ...definition, drawModulus: 0n },
      { ...definition, entities: -1 },
      { ...definition, pricing: { ...definition.pricing, entryReturn: rational(3n, 2n) } },
      null,
      'game',
    ])
      expect(() => belief(broken as never, steps)).toThrowError(RevealEngineError);
    expect(() => price(definition, steps, null as never)).toThrowError(RevealEngineError);
    expect(() => price(definition, steps, { entity: 0, contractId: 'ghost' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CHOICE' }),
    );
  });

  it('refuses a hand-built contract whose lane width would not terminate', () => {
    // `laneWidth` is the decrement of the partition loop, so a zero, negative or
    // non-integer one does not produce a wrong partition — it hangs. These are
    // exported helpers, so the bound is theirs to enforce.
    const sane = definition.contracts[0] as (typeof definition.contracts)[number];
    for (const laneWidth of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const broken = { ...sane, laneWidth } as unknown as typeof sane;
      expect(() => laneSizes(broken, 5)).toThrowError(
        expect.objectContaining({ code: 'INVALID_ADAPTER' }),
      );
      expect(() => lanePartition(broken, [0, 1, 2, 3, 4])).toThrowError(
        expect.objectContaining({ code: 'INVALID_ADAPTER' }),
      );
    }
    expect(() => lanePartition(sane, 'nope' as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CHOICE' }),
    );
    expect(() => laneSizes(sane, -1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CHOICE' }),
    );
    expect([...laneSizes(sane, 5)]).toEqual([3, 2]);
  });

  it('refuses a hostile stake or entity at the book boundary', async () => {
    const book = new SurvivalBook(definition);
    for (const [entity, stake] of [
      [0, 0n],
      [0, -5n],
      [-1, 100n],
      [99, 100n],
      [1.5, 100n],
    ] as const)
      await expect(
        book.enter(`k-${entity}-${stake}`, entity, stake as bigint),
      ).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
    await book.enter('ok', 0, 100n);
    await expect(book.enter('again', 0, 100n)).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
    await expect(book.bank('nothing', [])).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
    await expect(book.bank('unknown', [4])).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
  });

  it('refuses a live field resolveStage() cannot give a meaning to', () => {
    // `resolveStage()` is exported and it is the function that produces the step
    // object `book.resolve()` credits from, so it validates its own arguments
    // rather than trusting whichever caller reached it first. The order of
    // `live` is part of the geometry — `lanePartition()` cuts consecutive
    // slices — so a descending or duplicated field is not a tidiness problem,
    // it is a different joint law.
    for (const live of [
      [0, 0, 1],
      [0, 99],
      [0.5, 1],
      [2, 1, 0],
      Array.from({ length: 500 }, (_value, index) => index),
      [],
      'field',
    ])
      expect(() =>
        resolveStage(
          definition,
          'narrow',
          live as readonly number[],
          () => 0n,
          () => 0n,
        ),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_CHOICE' }));
  });

  it('refuses a draw outside the declared modulus rather than comparing it anyway', () => {
    // A draw outside `[0, drawModulus)` is not a rare value: it is a comparison
    // against a threshold that has stopped meaning anything. A negative lane
    // draw collapses every lane and a draw at the modulus collapses none,
    // whatever probability the contract declared.
    for (const draw of [-1n, definition.drawModulus, definition.drawModulus + 1n])
      expect(() =>
        resolveStage(
          definition,
          'narrow',
          [0, 1, 2, 3, 4],
          () => draw,
          () => 0n,
        ),
      ).toThrowError(expect.objectContaining({ code: 'DERIVATION_FAILED' }));
    // The entity draw is only read when the lane held, so the lane draw has to
    // miss the collapse threshold for this arm to reach the entity source at all.
    for (const entityDraw of [-1n, definition.drawModulus, 5 as never, undefined as never])
      expect(() =>
        resolveStage(
          definition,
          'narrow',
          [0, 1, 2, 3, 4],
          () => definition.drawModulus - 1n,
          () => entityDraw,
        ),
      ).toThrowError(expect.objectContaining({ code: 'DERIVATION_FAILED' }));
  });
});

/**
 * The live path and the reconnect path must admit exactly the same steps.
 *
 * `resolve()` once checked the resolved set and skipped the lane geometry that
 * `restore()` re-derives. The consequence was not a mispriced round: it was a
 * book that could take a `bank()` credit and then never reconnect — the same
 * availability defect the changelog records for `enter -> bank -> enter`, one
 * field over. These tests are the ones whose absence let it through.
 */
describe('staged-survival: resolve() and restore() admit the same steps', () => {
  async function atDecision(): Promise<{ book: SurvivalBook; honest: SurvivalStep }> {
    const book = new SurvivalBook(definition);
    for (let entity = 0; entity < definition.entities; entity += 1)
      await book.enter(`e-${entity}`, entity, 1_000n);
    await book.choose('c-0', 'wide');
    return { book, honest: goodTranscript.steps[0] as SurvivalStep };
  }

  const forgeries: readonly [string, (step: SurvivalStep) => SurvivalStep][] = [
    [
      'lanes re-cut into singletons',
      (step) => ({
        ...step,
        lanes: [...step.survivors, ...step.failed]
          .sort((left, right) => left - right)
          .map((entity) => ({ entities: [entity], collapsed: false })),
      }),
    ],
    ['lanes emptied', (step) => ({ ...step, lanes: [] })],
    [
      'lane entities duplicated across two lanes',
      (step) => ({
        ...step,
        lanes: step.lanes.map(() => ({
          entities: [...step.survivors, ...step.failed].sort((left, right) => left - right),
          collapsed: false,
        })),
      }),
    ],
    [
      'a lane widened past the contract geometry',
      (step) => ({
        ...step,
        lanes: [
          {
            entities: [...step.survivors, ...step.failed].sort((left, right) => left - right),
            collapsed: false,
          },
        ],
      }),
    ],
    ['lanes dropped entirely', (step) => ({ ...step, lanes: undefined as never })],
  ];

  it.each(forgeries)('rejects a step whose %s', async (_label, forge) => {
    const { book, honest } = await atDecision();
    await expect(book.resolve(forge(honest))).rejects.toMatchObject({
      code: 'TRANSCRIPT_MISMATCH',
    });
    // Rejected before any mutation: the stage is still open and the book is
    // still exactly where it was.
    expect(book.stageRevision).toBe(0);
    expect(book.steps).toEqual([]);
    expect(book.live).toEqual([0, 1, 2, 3, 4]);
  });

  it('fails closed with a typed error on a structurally hostile step', async () => {
    // `resolve()` is the one entry point that takes a step as a raw object
    // rather than through `parseWireStepList`, so it is the one place a missing
    // or mistyped field could surface as a bare `TypeError` out of a
    // money-bearing command. Four of these did exactly that before the shape
    // check existed: `survivors`, `failed` and `banked` undefined, and `failed`
    // as a number.
    const { honest } = await atDecision();
    const cases: readonly [string, unknown][] = [
      ['survivors undefined', { ...honest, survivors: undefined }],
      ['failed undefined', { ...honest, failed: undefined }],
      ['banked undefined', { ...honest, banked: undefined }],
      ['failed a number', { ...honest, failed: 3 }],
      ['survivors a string', { ...honest, survivors: 'x' }],
      ['fractional entity', { ...honest, survivors: [0.5] }],
      ['contractId missing', { ...honest, contractId: undefined }],
      ['lanes a string', { ...honest, lanes: 'x' }],
      ['a null lane', { ...honest, lanes: [null] }],
      ['a lane without entities', { ...honest, lanes: [{ collapsed: false }] }],
      ['a lane without a collapse flag', { ...honest, lanes: [{ entities: [0] }] }],
      [
        // Read as an own property or not at all, exactly as the wire boundary
        // treats an inherited key.
        'lanes inherited from a prototype',
        Object.assign(Object.create({ lanes: honest.lanes }), {
          index: 0,
          contractId: honest.contractId,
          banked: [...honest.banked],
          survivors: [...honest.survivors],
          failed: [...honest.failed],
        }),
      ],
    ];
    for (const [label, step] of cases) {
      const book = await atDecision();
      let thrown: unknown;
      try {
        await book.book.resolve(step as SurvivalStep);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, label).toBeInstanceOf(RevealEngineError);
      expect((thrown as RevealEngineError).code, label).toBe('TRANSCRIPT_MISMATCH');
      expect((thrown as RevealEngineError).path, label).toMatch(/^\$/u);
      expect(book.book.stageRevision, label).toBe(0);
    }
  });

  it('rejects a collapsed lane that reports a survivor', async () => {
    const { book, honest } = await atDecision();
    // Only meaningful when the honest step actually has one; the reference and
    // this seed do, and the assertion says so rather than passing vacuously.
    expect(honest.survivors.length).toBeGreaterThan(0);
    await expect(
      book.resolve({
        ...honest,
        lanes: honest.lanes.map((lane) => ({ ...lane, collapsed: true })),
      }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPT_MISMATCH' });
    expect(book.stageRevision).toBe(0);
  });

  it('leaves no accepted step that a later restore() would refuse', async () => {
    // The metamorphic form of the same law, which is the one that keeps holding
    // when someone adds a sixth forgery: whatever the live path admits, the
    // reconnect path must admit too, or the round is credited into a state it
    // can never be resumed from.
    const shapes: ((step: SurvivalStep) => SurvivalStep)[] = [
      (step) => step,
      ...forgeries.map(([, forge]) => forge),
      (step) => ({ ...step, survivors: [...step.failed], failed: [...step.survivors] }),
      (step) => ({ ...step, survivors: [...step.survivors, ...step.failed], failed: [] }),
      (step) => ({ ...step, contractId: 'narrow' }),
    ];
    let accepted = 0;
    for (const [index, shape] of shapes.entries()) {
      const { book, honest } = await atDecision();
      let step: SurvivalStep;
      try {
        step = shape(honest);
      } catch {
        continue;
      }
      try {
        await book.resolve(step);
      } catch {
        continue;
      }
      accepted += 1;
      // Accepted live, so it must reconnect — and reconnect to the same book.
      const restored = SurvivalBook.restore(definition, book.snapshot());
      expect({ shape: index, live: restored.live }).toEqual({ shape: index, live: book.live });
      expect(restored.steps).toEqual(book.steps);
    }
    // The honest step is in the list, so a run in which nothing was accepted
    // would mean the test proved its law by refusing everything.
    expect(accepted).toBeGreaterThan(0);
  });

  it('credits a forged survivor set and then refuses it at settlement', async () => {
    // The residual §9 names, pinned from both sides rather than asserted in
    // prose. `assertStepGeometry()` cannot check *which* entities in a lane that
    // held actually cleared — those are committed draw bits and the book holds
    // no seed — so a host that resolves with a step it did not derive is
    // credited on it. `settle()` is the backstop, and this is the test that the
    // backstop actually closes.
    const seedHex = seed(3);
    const roundId = roundRefId({ roundId: 'credit-order', clientEntropy: 'a1'.repeat(32) });
    const truth = deriveTruth(seedHex, definition, roundId);
    const honest = deriveSteps(definition, truth, [
      { contractId: 'wide', banked: [] },
    ])[0] as SurvivalStep;
    // The scenario is only meaningful when the honest step kills something.
    expect(honest.failed.length).toBeGreaterThan(0);
    const field = [...honest.survivors, ...honest.failed].sort((left, right) => left - right);

    const open = async (): Promise<SurvivalBook> => {
      const book = new SurvivalBook(definition);
      for (let entity = 0; entity < definition.entities; entity += 1)
        await book.enter(`e-${entity}`, entity, 1_000n);
      await book.choose('c', 'wide');
      return book;
    };

    const honestBook = await open();
    await honestBook.resolve(honest);
    await honestBook.bank('b', [...honest.survivors]);

    // Same lanes, same field, same contract — only the survivor bits differ,
    // which is exactly the part no seed-free check can reach.
    const forgedBook = await open();
    await forgedBook.resolve({
      index: 0,
      contractId: 'wide',
      banked: [],
      lanes: honest.lanes.map((lane) => ({ ...lane, collapsed: false })),
      survivors: field,
      failed: [],
    });
    await forgedBook.bank('b', field);
    expect(forgedBook.liquidBalance).toBeGreaterThan(honestBook.liquidBalance);

    // Settlement re-derives from the revealed seed and refuses — with the
    // forged credit still standing and the round not terminal, which is the
    // shape of the residual and the reason it is documented rather than closed.
    const credited = forgedBook.liquidBalance;
    await expect(
      forgedBook.settle(
        's',
        seedHex,
        makeTranscript(seedHex, definition, roundId, forgedBook.choices),
      ),
    ).rejects.toMatchObject({ code: 'TRANSCRIPT_MISMATCH' });
    expect(forgedBook.liquidBalance).toBe(credited);
    expect(forgedBook.terminal).toBe(false);
  });
});
