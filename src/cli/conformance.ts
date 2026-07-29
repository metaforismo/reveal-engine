#!/usr/bin/env node
import { checkModuleConformance } from '../conformance/module-conformance.js';
import { listModules } from '../modules/index.js';

/**
 * Registry-driven conformance run.
 *
 * Every registered module contributes the reference definitions it declares, so
 * a new lifecycle module appears here — and therefore in the CI conformance
 * step — by registering itself and declaring `conformance.references`. Nothing
 * in this file is module-specific, and adding a module must never require
 * editing it.
 */
const SEEDS = 16;

const modules = listModules();
const reports = modules.flatMap((module) =>
  module.conformance.references.map((reference) =>
    checkModuleConformance(module, reference.definition, SEEDS),
  ),
);

console.log(
  JSON.stringify(
    {
      schema: 'reveal-engine/conformance-run-v1',
      seeds: SEEDS,
      modules: modules.map((module) => ({
        id: module.id,
        version: module.version,
        references: module.conformance.references.map((reference) => reference.id),
      })),
      reports,
    },
    null,
    2,
  ),
);

if (reports.length === 0) {
  console.error('No lifecycle module declared a conformance reference.');
  process.exitCode = 1;
}
if (reports.some((report) => !report.ok)) process.exitCode = 1;
