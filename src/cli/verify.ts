#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import {
  blackSignalReference,
  constellationReference,
  verifyTranscript,
  type Transcript,
} from '../index.js';
const [file, seed] = process.argv.slice(2);
if (!file || !seed) {
  console.error('Usage: reveal-verify <transcript.json> <revealed-seed-hex>');
  process.exitCode = 2;
} else {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Transcript;
  const game =
    parsed.context.gameId === blackSignalReference.id
      ? blackSignalReference
      : parsed.context.gameId === constellationReference.id
        ? constellationReference
        : undefined;
  if (!game) throw new Error('Unknown reference game id');
  const ok = verifyTranscript(seed, game, parsed);
  console.log(
    JSON.stringify({
      verified: ok,
      gameId: parsed.context.gameId,
      roundId: parsed.context.roundId,
    }),
  );
  process.exitCode = ok ? 0 : 1;
}
