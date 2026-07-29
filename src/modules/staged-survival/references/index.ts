import { rational } from '../../../core/rational.js';
import { ENGINE_API_VERSION } from '../../../core/versions.js';
import { defineSurvivalGame } from '../adapter.js';
import type { SurvivalDefinition } from '../contracts.js';

/**
 * The shipped reference adapter: five runners, three stages, three contracts.
 *
 * It is a toy, and it is deliberately the *shape* the two real consumers need
 * rather than either of them. The three contracts span the whole correlation
 * range the module is built for, and they are the point of the reference:
 *
 * | contract | lane width | `q` (shared shock) | `c` (per entity) | marginal `p` | `mu` |
 * | -------- | ---------- | ------------------ | ---------------- | ------------ | ---- |
 * | `wide`   | 3          | `1/25`             | `7/8`            | `21/25`      | `25/21` |
 * | `split`  | 2          | `0`                | `3/4`            | `3/4`        | `4/3`   |
 * | `narrow` | 1          | `1/2`              | `1/2`            | `1/4`        | `4/1`   |
 *
 * - `wide` is the safest per entity and the most correlated: three runners share
 *   one collapse draw, so their fates are far from independent.
 * - `split` cuts the field into pairs and declares `q` **exactly zero**, so its
 *   entities are exactly independent — zero, not an epsilon, which is why the
 *   joint law is a clean product and the oracle can check it as one.
 * - `narrow` is one runner per lane: correlation is structurally absent and the
 *   marginal is the lowest, paid for with the largest multiplier.
 *
 * Every contract satisfies `p * mu = 1` exactly, so every route through the
 * round returns the same and the entry margin — `191/200` — is the whole edge.
 * The exact maximum round return is `191/200 * 4^3 = 1528/25 = 61.12`, which is
 * why a `maxWinMultiple` of `100` can be declared unreachable.
 */
export const fiveRunnerReference: SurvivalDefinition = defineSurvivalGame({
  apiVersion: ENGINE_API_VERSION,
  id: 'five-runner-trial-v1',
  version: '1.0.0',
  entities: 5,
  stages: 3,
  contracts: [
    {
      id: 'wide',
      label: 'Wide — three abreast, one shared collapse',
      laneWidth: 3,
      minEntities: 3,
      profile: { laneFailure: rational(1n, 25n), entitySurvival: rational(7n, 8n) },
      multiplier: rational(25n, 21n),
    },
    {
      id: 'split',
      label: 'Split — pairs, resolved independently',
      laneWidth: 2,
      minEntities: 2,
      profile: { laneFailure: rational(0n, 1n), entitySurvival: rational(3n, 4n) },
      multiplier: rational(4n, 3n),
    },
    {
      id: 'narrow',
      label: 'Narrow — one runner per lane, no shelter',
      laneWidth: 1,
      minEntities: 1,
      profile: { laneFailure: rational(1n, 2n), entitySurvival: rational(1n, 2n) },
      multiplier: rational(4n, 1n),
    },
  ],
  // Divisible by every reduced denominator on the menu (25, 8, 4, 2, 1).
  drawModulus: 1_200_000n,
  pricing: {
    entryReturn: rational(191n, 200n),
    continuationReturn: rational(1n),
    rounding: 'floor',
  },
  risk: { maxWinMultiple: 100n, capBasis: 'round-external-stake', capMustBeUnreachable: true },
});

/**
 * The instance the oracle test enumerates exhaustively: three entities, two
 * stages, two contracts.
 *
 * It is small enough that every elementary event of every stage — each lane
 * shock and each entity clear, under every contract and every reachable field —
 * can be enumerated and priced exactly, and it still carries both correlation
 * regimes: `pair` shares a shock across two entities, `solo` does not share at
 * all. The exact maximum round return is `9/10 * 2^2 = 18/5`, so a
 * `maxWinMultiple` of `4` is unreachable.
 */
export const oracleTrialReference: SurvivalDefinition = defineSurvivalGame({
  apiVersion: ENGINE_API_VERSION,
  id: 'oracle-trial-v1',
  version: '1.0.0',
  entities: 3,
  stages: 2,
  contracts: [
    {
      id: 'pair',
      label: 'Pair — two abreast, one shared collapse',
      laneWidth: 2,
      minEntities: 1,
      profile: { laneFailure: rational(1n, 3n), entitySurvival: rational(3n, 4n) },
      multiplier: rational(2n, 1n),
    },
    {
      id: 'solo',
      label: 'Solo — one entity per lane',
      laneWidth: 1,
      minEntities: 1,
      profile: { laneFailure: rational(0n, 1n), entitySurvival: rational(2n, 3n) },
      multiplier: rational(3n, 2n),
    },
  ],
  drawModulus: 12n,
  pricing: {
    entryReturn: rational(9n, 10n),
    continuationReturn: rational(1n),
    rounding: 'floor',
  },
  risk: { maxWinMultiple: 4n, capBasis: 'round-external-stake', capMustBeUnreachable: true },
});
