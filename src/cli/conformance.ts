#!/usr/bin/env node
import {
  binaryBeaconReference,
  blackSignalReference,
  constellationReference,
} from '../reference/index.js';
import { checkAdapterConformance } from '../conformance/adapter-conformance.js';

const reports = [blackSignalReference, constellationReference, binaryBeaconReference].map((game) =>
  checkAdapterConformance(game, 16),
);
console.log(JSON.stringify({ schema: 'reveal-engine/conformance-run-v1', reports }, null, 2));
if (reports.some((report) => !report.ok)) process.exitCode = 1;
