#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { ENGINE_LIMITS } from '../api/limits.js';
import { verifyTranscriptDetailed } from '../modules/progressive-market/fairness.js';
import { deserializeTranscript } from '../modules/progressive-market/transcript.js';
import {
  binaryBeaconReference,
  blackSignalReference,
  constellationReference,
} from '../modules/progressive-market/references/index.js';

const [file, seed] = process.argv.slice(2);
if (!file || !seed) {
  console.error(
    JSON.stringify({
      ok: false,
      code: 'USAGE',
      message: 'Usage: reveal-verify <transcript.json> <revealed-seed-hex>',
    }),
  );
  process.exitCode = 2;
} else {
  try {
    if (statSync(file).size > ENGINE_LIMITS.maxTranscriptBytes)
      throw new Error('Transcript exceeds byte limit');
    const source = readFileSync(file, 'utf8');
    const transcript = deserializeTranscript(source);
    const game = [blackSignalReference, constellationReference, binaryBeaconReference].find(
      (candidate) => candidate.id === transcript.context.gameId,
    );
    if (!game) throw new Error('Unknown reference adapter');
    const result = verifyTranscriptDetailed(seed, game, transcript);
    console.log(
      JSON.stringify({
        ...result,
        moduleId: 'progressive-market',
        gameId: transcript.context.gameId,
        roundId: transcript.context.roundId,
      }),
    );
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code: 'INVALID_TRANSCRIPT',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}
