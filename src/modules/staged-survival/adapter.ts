import { sealCommitment } from '../../core/commitment.js';
import type { DefinitionIdentity } from '../../core/module.js';
import { rational } from '../../core/rational.js';
import { encodeFields, type CanonicalField } from '../../internal/canonical.js';
import { ENGINE_API_VERSION } from '../../core/versions.js';
import {
  STAGED_SURVIVAL_MODULE_ID,
  STAGED_SURVIVAL_MODULE_VERSION,
  type StageContract,
  type SurvivalDefinition,
} from './contracts.js';
import { laneSizes } from './distribution.js';
import { assertCapIsUnreachable, assertSurvivalDefinition } from './validation.js';

/** The all-zero seed: the fingerprint is a digest of declarations, not of a round. */
const FINGERPRINT_SEED = '00'.repeat(32);

function contractFields(definition: SurvivalDefinition, contract: StageContract): CanonicalField[] {
  const laneFailure = rational(
    contract.profile.laneFailure.numerator,
    contract.profile.laneFailure.denominator,
  );
  const entitySurvival = rational(
    contract.profile.entitySurvival.numerator,
    contract.profile.entitySurvival.denominator,
  );
  const multiplier = rational(contract.multiplier.numerator, contract.multiplier.denominator);
  const fields: CanonicalField[] = [
    contract.id,
    contract.laneWidth,
    contract.minEntities,
    laneFailure.numerator,
    laneFailure.denominator,
    entitySurvival.numerator,
    entitySurvival.denominator,
    multiplier.numerator,
    multiplier.denominator,
  ];
  // The enumerated lane SIZES, not just the width that generates them.
  //
  // The width names the geometry; the sizes are what actually determine the
  // survivor distribution. Binding only the width would leave a hole: keep
  // `laneWidth` and redefine how the remainder lane is cut, and the joint law —
  // and therefore every correlated price in the round — moves under an
  // unchanged fingerprint.
  for (let live = contract.minEntities; live <= definition.entities; live += 1) {
    const sizes = laneSizes(contract, live);
    fields.push(live, sizes.length, ...sizes);
  }
  return fields;
}

/** Every replay-visible declarative field, in a fixed order. Cosmetic labels are excluded. */
export function definitionFields(definition: SurvivalDefinition): CanonicalField[] {
  assertSurvivalDefinition(definition);
  const entryReturn = rational(
    definition.pricing.entryReturn.numerator,
    definition.pricing.entryReturn.denominator,
  );
  const continuationReturn = rational(
    definition.pricing.continuationReturn.numerator,
    definition.pricing.continuationReturn.denominator,
  );
  return [
    'staged-survival definition',
    ENGINE_API_VERSION,
    STAGED_SURVIVAL_MODULE_ID,
    definition.id,
    definition.version,
    definition.entities,
    definition.stages,
    definition.drawModulus,
    definition.contracts.length,
    ...definition.contracts.flatMap((contract) => contractFields(definition, contract)),
    entryReturn.numerator,
    entryReturn.denominator,
    continuationReturn.numerator,
    continuationReturn.denominator,
    definition.pricing.rounding,
    definition.risk.maxWinMultiple,
    definition.risk.capBasis,
    definition.risk.capMustBeUnreachable ? 1 : 0,
  ];
}

/**
 * 32-byte digest over every replay-visible declarative field.
 *
 * Two configurations that could pay differently never share one: the contract
 * menu, the lane geometry enumerated size by size, both returns, the rounding
 * mode, the cap and its basis are all inside. A player renaming a runner is not
 * — `label` is cosmetic and stays out, so a cosmetic edit cannot change the
 * identity of the game being played.
 */
export function survivalFingerprint(definition: SurvivalDefinition): string {
  return sealCommitment(FINGERPRINT_SEED, encodeFields(definitionFields(definition)));
}

export function survivalIdentity(definition: SurvivalDefinition): DefinitionIdentity {
  assertSurvivalDefinition(definition);
  return Object.freeze({
    moduleId: STAGED_SURVIVAL_MODULE_ID,
    moduleVersion: STAGED_SURVIVAL_MODULE_VERSION,
    definitionId: definition.id,
    definitionVersion: definition.version,
    fingerprint: survivalFingerprint(definition),
  });
}

/**
 * The only supported construction path: validate, clone, deep-freeze.
 *
 * Both mechanical obligations run here, eagerly, so a malformed configuration
 * cannot reach a round:
 *
 * - every contract satisfies `marginalSurvival * multiplier == continuationReturn`
 *   exactly (in `assertSurvivalDefinition`), which is what makes every contract
 *   path return the same;
 * - when `risk.capMustBeUnreachable`, the exact maximum round return sits
 *   strictly below `risk.maxWinMultiple`, so no advertised win can be clipped.
 */
export function defineSurvivalGame(input: SurvivalDefinition): SurvivalDefinition {
  assertSurvivalDefinition(input);
  const definition: SurvivalDefinition = Object.freeze({
    apiVersion: ENGINE_API_VERSION,
    id: input.id,
    version: input.version,
    entities: input.entities,
    stages: input.stages,
    drawModulus: input.drawModulus,
    contracts: Object.freeze(
      input.contracts.map((contract) =>
        Object.freeze({
          id: contract.id,
          label: contract.label,
          laneWidth: contract.laneWidth,
          minEntities: contract.minEntities,
          profile: Object.freeze({
            laneFailure: rational(
              contract.profile.laneFailure.numerator,
              contract.profile.laneFailure.denominator,
            ),
            entitySurvival: rational(
              contract.profile.entitySurvival.numerator,
              contract.profile.entitySurvival.denominator,
            ),
          }),
          multiplier: rational(contract.multiplier.numerator, contract.multiplier.denominator),
        }),
      ),
    ),
    pricing: Object.freeze({
      entryReturn: rational(
        input.pricing.entryReturn.numerator,
        input.pricing.entryReturn.denominator,
      ),
      continuationReturn: rational(
        input.pricing.continuationReturn.numerator,
        input.pricing.continuationReturn.denominator,
      ),
      rounding: 'floor',
    }),
    risk: Object.freeze({
      maxWinMultiple: input.risk.maxWinMultiple,
      capBasis: 'round-external-stake',
      capMustBeUnreachable: input.risk.capMustBeUnreachable,
    }),
  });
  assertSurvivalDefinition(definition);
  if (definition.risk.capMustBeUnreachable) assertCapIsUnreachable(definition);
  survivalFingerprint(definition);
  return definition;
}
