import { compare, equal, multiply, rational } from '../../../core/rational.js';
import { sha256Hex } from '../../../core/random.js';
import { encodeFields } from '../../../internal/canonical.js';
import {
  computePermutationCatalogueDigest,
  instancesFor,
  permutationAdapterFingerprint,
  permutationFingerprintFields,
  viewsFor,
  type PermutationGameDefinition,
} from './definition.js';
import {
  allDrawVectors,
  factorial,
  factorialBig,
  fisherYates,
  type BetFamily,
  type BetInstance,
  type OutcomeView,
} from './families.js';
import { ENGINE_API_VERSION, PERMUTATION_LIMITS, PERMUTATION_MODULE_VERSION } from './identity.js';

export interface ConformanceCheck {
  readonly id: number;
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ConformanceReport {
  readonly variantId: string;
  readonly ok: boolean;
  readonly checks: readonly ConformanceCheck[];
}

const DETERMINISM_SAMPLE = 128;

function sampledViews(
  views: readonly OutcomeView[],
): Readonly<{ views: readonly OutcomeView[]; exhaustive: boolean }> {
  if (views.length <= factorial(6)) return Object.freeze({ views, exhaustive: true });
  const stride = Math.max(1, Math.floor(views.length / DETERMINISM_SAMPLE));
  const sample: OutcomeView[] = [];
  for (let index = 0; index < views.length && sample.length < DETERMINISM_SAMPLE; index += stride)
    sample.push(views[index] as OutcomeView);
  return Object.freeze({ views: Object.freeze(sample), exhaustive: false });
}

function deepFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null) return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((child) => deepFrozen(child, seen));
}

function stableInstances(instances: readonly BetInstance[]): string {
  return JSON.stringify(
    instances.map((instance) => ({
      code: instance.code,
      label: instance.label,
      params: Object.fromEntries(
        Object.entries(instance.params).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
    })),
  );
}

interface AnalysisRow {
  readonly family: BetFamily;
  readonly instances: readonly BetInstance[];
  readonly wins: readonly number[];
  readonly signatures: readonly string[];
}

function analyze(game: PermutationGameDefinition): readonly AnalysisRow[] {
  const views = viewsFor(game);
  return Object.freeze(
    game.bets.map((family) => {
      const instances = instancesFor(game, family);
      const signatures: string[] = [];
      const wins = instances.map((instance) => {
        let count = 0;
        const bitmap = Buffer.alloc(Math.ceil(views.length / 8));
        for (let index = 0; index < views.length; index += 1) {
          const view = views[index] as OutcomeView;
          const verdict = family.resolve(instance, view);
          if (verdict !== true && verdict !== false)
            throw new TypeError(`${family.code}/${instance.label} returned a non-boolean`);
          if (verdict) {
            count += 1;
            bitmap[index >> 3] = (bitmap[index >> 3] as number) | (1 << (index & 7));
          }
        }
        signatures.push(sha256Hex(bitmap));
        return count;
      });
      return Object.freeze({
        family,
        instances,
        wins: Object.freeze(wins),
        signatures: Object.freeze(signatures),
      });
    }),
  );
}

export function assertPermutationAdapterConforms(
  game: PermutationGameDefinition,
): ConformanceReport {
  const checks: ConformanceCheck[] = [];
  const record = (id: number, name: string, ok: boolean, detail: string): void => {
    checks.push(Object.freeze({ id, name, ok, detail }));
  };

  // 1 — structure
  {
    const problems: string[] = [];
    if (game.apiVersion !== ENGINE_API_VERSION) problems.push('apiVersion');
    if (game.moduleVersion !== PERMUTATION_MODULE_VERSION) problems.push('moduleVersion');
    for (const [name, value] of [
      ['id', game.id],
      ['variantId', game.variantId],
      ['adapterVersion', game.adapterVersion],
    ] as const)
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        Buffer.byteLength(value, 'utf8') > 128 ||
        !/^[\x20-\x7e]+$/u.test(value)
      )
        problems.push(name);
    if (!Number.isSafeInteger(game.n) || game.n < 2 || game.n > PERMUTATION_LIMITS.maxElements)
      problems.push('n');
    if (!Array.isArray(game.elements) || game.elements.length !== game.n)
      problems.push('elements.length');
    else if (new Set(game.elements).size !== game.elements.length)
      problems.push('element uniqueness');
    if (!deepFrozen(game)) problems.push('definition is not deep-frozen');
    record(
      1,
      'structure',
      problems.length === 0,
      problems.length === 0
        ? `n=${game.n}, ${game.elements.length} unique elements, deep-frozen`
        : problems.join('; '),
    );
  }

  // 2 — catalogue completeness
  {
    try {
      const codes = game.bets.map((family) => family.code);
      const priced = Object.keys(game.pricing.multipliers);
      const unpriced = codes.filter((code) => !(code in game.pricing.multipliers));
      const orphaned = priced.filter((code) => !codes.includes(code));
      const duplicateCodes = codes.length !== new Set(codes).size;
      const duplicateLabels = game.bets
        .filter((family) => {
          const labels = family.enumerateInstances(game.n).map((value) => value.label);
          return labels.length !== new Set(labels).size;
        })
        .map((family) => family.code);
      const ok =
        unpriced.length === 0 &&
        orphaned.length === 0 &&
        !duplicateCodes &&
        duplicateLabels.length === 0;
      record(
        2,
        'catalogue completeness',
        ok,
        ok
          ? `${codes.length} families, all priced, all labels unique`
          : `unpriced=${unpriced.join(',')} orphaned=${orphaned.join(',')} duplicateCodes=${duplicateCodes} duplicateLabels=${duplicateLabels.join(',')}`,
      );
    } catch (error) {
      record(2, 'catalogue completeness', false, String(error));
    }
  }

  const conformanceEnumerable = game.n <= PERMUTATION_LIMITS.maxExhaustiveElements;
  let views: readonly OutcomeView[] = [];
  let analysis: readonly AnalysisRow[] = [];
  if (conformanceEnumerable) {
    try {
      views = viewsFor(game);
      analysis = analyze(game);
    } catch {
      // Individual checks below report the failed evidence rather than letting
      // one hostile predicate abort the whole twelve-check report.
    }
  }

  // 3 — determinism
  {
    try {
      if (!conformanceEnumerable) throw new RangeError('refused above exhaustive ceiling');
      const probe = sampledViews(views);
      let problem = '';
      for (const family of game.bets) {
        const first = family.enumerateInstances(game.n);
        const second = family.enumerateInstances(game.n);
        if (stableInstances(first) !== stableInstances(second)) {
          problem = `${family.code}: enumerateInstances changed between calls`;
          break;
        }
        outer: for (const instance of instancesFor(game, family))
          for (const view of probe.views) {
            const one = family.resolve(instance, view);
            const two = family.resolve(instance, view);
            if (one !== two) {
              problem = `${family.code}/${instance.label}: resolve changed between calls`;
              break outer;
            }
          }
        if (problem) break;
      }
      record(
        3,
        'determinism',
        problem === '',
        problem ||
          `identical over ${probe.views.length}/${views.length} outcomes (${probe.exhaustive ? 'exhaustive' : 'deterministic 128-outcome stride sample'})`,
      );
    } catch (error) {
      record(3, 'determinism', false, String(error));
    }
  }

  // 4 — purity
  {
    try {
      if (!conformanceEnumerable) throw new RangeError('refused above exhaustive ceiling');
      const probe = sampledViews(views);
      let problem = '';
      outer: for (const family of game.bets)
        for (const instance of instancesFor(game, family)) {
          const beforeInstance = stableInstances([instance]);
          for (const view of probe.views) {
            const beforeView = JSON.stringify(view);
            try {
              family.resolve(Object.freeze(instance), Object.freeze(view));
            } catch {
              problem = `${family.code}/${instance.label}: resolve attempted to mutate or threw`;
              break outer;
            }
            if (
              stableInstances([instance]) !== beforeInstance ||
              JSON.stringify(view) !== beforeView
            ) {
              problem = `${family.code}/${instance.label}: resolve mutated an argument`;
              break outer;
            }
          }
        }
      record(
        4,
        'purity',
        problem === '',
        problem ||
          `no mutation over ${probe.views.length}/${views.length} outcomes (${probe.exhaustive ? 'exhaustive' : 'deterministic 128-outcome stride sample'})`,
      );
    } catch (error) {
      record(4, 'purity', false, String(error));
    }
  }

  // 5 — non-degeneracy
  {
    const ok =
      analysis.length === game.bets.length &&
      analysis.every((row) => row.wins.every((wins) => wins > 0 && wins < views.length));
    record(
      5,
      'non-degeneracy',
      ok,
      conformanceEnumerable
        ? ok
          ? 'every instance wins on at least one and not all outcomes'
          : 'a family is empty, always losing, always winning, or threw'
        : 'refused: exhaustive checks require n <= 8',
    );
  }

  // 6 — homogeneity
  {
    const offenders = analysis
      .filter((row) => row.wins.some((wins) => wins !== row.wins[0]))
      .map((row) => row.family.code);
    const ok =
      conformanceEnumerable && analysis.length === game.bets.length && offenders.length === 0;
    record(
      6,
      'homogeneity',
      ok,
      ok
        ? 'all instances in each family share one exact win count'
        : conformanceEnumerable
          ? `non-homogeneous=${offenders.join(',') || 'predicate failed'}`
          : 'refused: exhaustive checks require n <= 8',
    );
  }

  // 7 — exact pricing identity
  {
    const total = factorialBig(game.n);
    const offenders = analysis
      .filter((row) => {
        const multiplier = game.pricing.multipliers[row.family.code];
        if (!multiplier || row.wins.length === 0) return true;
        return !equal(
          multiply(multiplier, rational(BigInt(row.wins[0] as number), total)),
          game.pricing.targetRtp,
        );
      })
      .map((row) => row.family.code);
    const ok =
      conformanceEnumerable && analysis.length === game.bets.length && offenders.length === 0;
    record(
      7,
      'pricing identity',
      ok,
      ok
        ? `multiplier x wins/${total} equals target RTP for all ${analysis.length} families`
        : conformanceEnumerable
          ? `mispriced=${offenders.join(',') || 'predicate failed'}`
          : 'refused: exhaustive checks require n <= 8',
    );
  }

  // 8 — quantum
  {
    const offenders = Object.entries(game.pricing.multipliers)
      .filter(([, multiplier]) => game.pricing.stakeQuantum % multiplier.denominator !== 0n)
      .map(([code]) => code);
    record(
      8,
      'stake quantum',
      offenders.length === 0,
      offenders.length === 0
        ? `every multiplier denominator divides ${game.pricing.stakeQuantum}`
        : `non-divisors=${offenders.join(',')}`,
    );
  }

  // 9 — cap headroom
  {
    const offenders = Object.entries(game.pricing.multipliers)
      .filter(([, multiplier]) => compare(multiplier, rational(game.risk.maxWinMultiple)) >= 0)
      .map(([code]) => code);
    record(
      9,
      'cap headroom',
      offenders.length === 0,
      offenders.length === 0
        ? `every multiplier is strictly below ${game.risk.maxWinMultiple}`
        : `cap can bind=${offenders.join(',')}`,
    );
  }

  // 10 — Fisher-Yates bijection
  {
    if (!conformanceEnumerable)
      record(10, 'shuffle bijection', false, 'refused: exhaustive checks require n <= 8');
    else {
      const images = new Set(
        allDrawVectors(game.n).map((draws) => fisherYates(game.n, draws).join(',')),
      );
      const expected = factorial(game.n);
      record(
        10,
        'shuffle bijection',
        images.size === expected,
        `${expected} draw vectors map to ${images.size} distinct permutations`,
      );
    }
  }

  // 11 — behavioral fingerprint
  {
    try {
      if (!conformanceEnumerable) throw new RangeError('refused above exhaustive ceiling');
      const recomputed = computePermutationCatalogueDigest(game);
      const rebuilt = sha256Hex(encodeFields(permutationFingerprintFields(game, recomputed)));
      const decoy = sha256Hex(encodeFields(permutationFingerprintFields(game, '0'.repeat(64))));
      const shipped = permutationAdapterFingerprint(game);
      const ok = rebuilt === shipped && decoy !== shipped;
      record(
        11,
        'behavioral fingerprint',
        ok,
        ok
          ? `recomputed catalogue ${recomputed.slice(0, 16)}... is live in the fingerprint`
          : 'fingerprint does not bind the recomputed catalogue behavior',
      );
    } catch (error) {
      record(11, 'behavioral fingerprint', false, String(error));
    }
  }

  // 12 — behavioral claim aliases
  {
    const groups = new Map<string, string[]>();
    if (conformanceEnumerable && analysis.length === game.bets.length)
      for (const row of analysis)
        for (let index = 0; index < row.instances.length; index += 1) {
          const instance = row.instances[index] as BetInstance;
          const signature = row.signatures[index] as string;
          const spellings = groups.get(signature) ?? [];
          spellings.push(`${row.family.code}:${instance.label}`);
          groups.set(signature, spellings);
        }
    const aliases = [...groups.values()].filter((spellings) => spellings.length > 1);
    const examples = aliases
      .slice(0, 4)
      .map((spellings) => spellings.join(' = '))
      .join(', ');
    record(
      12,
      'claim aliasing',
      conformanceEnumerable && analysis.length === game.bets.length,
      conformanceEnumerable
        ? `${aliases.length} behavioral alias group(s) reported${examples ? `: ${examples}${aliases.length > 4 ? ', ...' : ''}` : ''}`
        : 'refused: exhaustive checks require n <= 8',
    );
  }

  return Object.freeze({
    variantId: game.variantId,
    ok: checks.length === 12 && checks.every((check) => check.ok),
    checks: Object.freeze(checks),
  });
}
