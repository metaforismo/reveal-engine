#!/usr/bin/env node
import { checkModuleConformance } from '../conformance/module-conformance.js';
import { listModules } from '../modules/index.js';
import {
  binaryBeaconReference,
  blackSignalReference,
  constellationReference,
} from '../modules/progressive-market/references/index.js';
import { progressiveMarket } from '../modules/progressive-market/module.js';

const definitions = [blackSignalReference, constellationReference, binaryBeaconReference];
const reports = definitions.map((game) => checkModuleConformance(progressiveMarket, game, 16));
console.log(
  JSON.stringify(
    {
      schema: 'reveal-engine/conformance-run-v1',
      modules: listModules().map((module) => ({ id: module.id, version: module.version })),
      reports,
    },
    null,
    2,
  ),
);
if (reports.some((report) => !report.ok)) process.exitCode = 1;
