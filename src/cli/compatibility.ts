#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RevealEngineError } from '../api/errors.js';
import { ENGINE_LIMITS } from '../api/limits.js';
import { compareCompatibilityCorpus } from '../compatibility/compare.js';
import type { CompatibilityCorpusV1 } from '../compatibility/contracts.js';
import { parseCompatibilityCorpus } from '../compatibility/corpus.js';
import type { GameDefinition } from '../core/contracts.js';
import {
  binaryBeaconReference,
  blackSignalReference,
  constellationReference,
} from '../reference/index.js';

interface Options {
  readonly corpusPath: string;
  readonly adapterModule?: string;
  readonly exportName: string;
  readonly json: boolean;
}

function usage(): never {
  process.stderr.write(
    'Usage: reveal-compatibility <corpus.json> [--adapter-module <esm-path> --export <name>] [--json]\n',
  );
  process.exit(1);
}

function options(argv: readonly string[]): Options {
  if (argv.length === 0 || argv.includes('--help')) usage();
  const corpusPath = argv[0];
  if (!corpusPath || corpusPath.startsWith('--')) usage();
  let adapterModule: string | undefined;
  let exportName = 'default';
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') json = true;
    else if (argument === '--adapter-module') {
      adapterModule = argv[index + 1];
      if (!adapterModule) usage();
      index += 1;
    } else if (argument === '--export') {
      exportName = argv[index + 1] ?? '';
      if (!exportName) usage();
      index += 1;
    } else usage();
  }
  return {
    corpusPath,
    ...(adapterModule === undefined ? {} : { adapterModule }),
    exportName,
    json,
  };
}

async function adapterFor(corpus: CompatibilityCorpusV1, parsed: Options): Promise<GameDefinition> {
  if (parsed.adapterModule) {
    const module = (await import(pathToFileURL(resolve(parsed.adapterModule)).href)) as Record<
      string,
      unknown
    >;
    const game = module[parsed.exportName];
    if (typeof game !== 'object' || game === null)
      throw new Error(`Adapter export ${parsed.exportName} is missing`);
    return game as GameDefinition;
  }
  const byId = new Map<string, GameDefinition>([
    [blackSignalReference.id, blackSignalReference],
    [binaryBeaconReference.id, binaryBeaconReference],
    [constellationReference.id, constellationReference],
  ]);
  const adapter = byId.get(corpus.target.adapterId);
  if (!adapter)
    throw new Error('Corpus adapter is not bundled; pass --adapter-module and --export');
  return adapter;
}

async function main(): Promise<void> {
  const parsed = options(process.argv.slice(2));
  const corpusPath = resolve(parsed.corpusPath);
  const metadata = await stat(corpusPath);
  if (metadata.size > ENGINE_LIMITS.maxCompatibilityCorpusBytes)
    throw new RevealEngineError('PAYLOAD_TOO_LARGE', 'Compatibility corpus exceeds byte limit');
  const input = await readFile(corpusPath, 'utf8');
  const corpus = parseCompatibilityCorpus(input);
  const report = compareCompatibilityCorpus(await adapterFor(corpus, parsed), corpus);
  if (parsed.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(
      [
        `${report.corpusId}: ${report.ok ? 'shadow-compatible' : 'failed'}`,
        `activationReady=${String(report.activationReady)}`,
        `vectors=${report.checked.vectors}`,
        `economicCases=${report.checked.economicCases}`,
        `exact=${report.classifications.exact}`,
        `expectedMigrationDeltas=${report.classifications['expected-migration-delta']}`,
        `hostManaged=${report.classifications['host-managed']}`,
        `unexpected=${report.classifications['unexpected-delta']}`,
        `targetDrift=${report.classifications['target-drift']}`,
        `corpusSha256=${report.corpusSha256}`,
      ].join('\n') + '\n',
    );
  }
  if (!report.ok) process.exitCode = 2;
}

main().catch((error: unknown) => {
  if (error instanceof RevealEngineError)
    process.stderr.write(`${error.code} ${error.path}: ${error.message}\n`);
  else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
