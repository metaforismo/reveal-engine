import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageName = '@axiom-games/reveal-engine';
const corpusExport = `${packageName}/compatibility/corpora/black-signal-v1.json`;
const corpusPath = 'compatibility-corpora/black-signal-v1.json';
const corpusSha256 = '60c669a3e05ac6084e11d489c12f4344f0826f7deefe550a8ee457c266f5f5a1';
const directory = mkdtempSync(join(tmpdir(), 'reveal-engine-pack-'));

try {
  const [pack] = JSON.parse(
    execFileSync(
      'npm',
      ['pack', '--json', '--pack-destination', directory, '--cache', join(directory, 'cache')],
      { encoding: 'utf8' },
    ),
  );
  const files = pack.files.map((entry) => entry.path);
  assert(files.includes('dist/index.js'));
  assert(files.includes('dist/cli/verify.js'));
  assert(files.includes('dist/cli/compatibility.js'));
  assert.deepEqual(
    files.filter((path) => path.startsWith('compatibility-corpora/')),
    [corpusPath],
  );
  assert(!files.some((path) => path.startsWith('src/') || path.startsWith('tests/')));

  const installDirectory = join(directory, 'consumer');
  execFileSync(
    'npm',
    [
      'install',
      join(directory, pack.filename),
      '--prefix',
      installDirectory,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--cache',
      join(directory, 'cache'),
    ],
    { encoding: 'utf8' },
  );

  const resolver = createRequire(join(installDirectory, 'package-smoke.mjs'));
  const importInstalled = async (specifier) =>
    import(pathToFileURL(resolver.resolve(specifier)).href);
  const root = await importInstalled(packageName);
  const api = await importInstalled(`${packageName}/api`);
  const core = await importInstalled(`${packageName}/core`);
  const protocol = await importInstalled(`${packageName}/protocol`);
  const serialization = await importInstalled(`${packageName}/serialization`);
  const conformance = await importInstalled(`${packageName}/conformance`);
  const integration = await importInstalled(`${packageName}/integration`);
  const reference = await importInstalled(`${packageName}/reference`);
  const compatibility = await importInstalled(`${packageName}/compatibility`);
  const packageManifest = JSON.parse(
    readFileSync(resolver.resolve(`${packageName}/package.json`), 'utf8'),
  );
  const corpusBytes = readFileSync(resolver.resolve(corpusExport));
  const corpus = compatibility.parseCompatibilityCorpus(corpusBytes.toString('utf8'));
  const report = compatibility.compareCompatibilityCorpus(reference.blackSignalReference, corpus);

  assert.equal(packageManifest.version, '0.3.1');
  assert.equal(createHash('sha256').update(corpusBytes).digest('hex'), corpusSha256);
  assert.equal(corpus.target.packageVersion, '0.3.0');
  assert.equal(root.ENGINE_API_VERSION, 'reveal-engine/api-v1');
  assert.equal(api.COMMITMENT_VERSION, 'reveal-engine/commit-v2');
  assert.equal(typeof core.uniformBigInt, 'function');
  assert.equal(core.commitment, undefined);
  assert.equal(typeof protocol.RoundBook, 'function');
  assert.equal(typeof serialization.deserializeTranscript, 'function');
  assert.equal(typeof conformance.checkAdapterConformance, 'function');
  assert.equal(typeof integration.RgsExample, 'function');
  assert.equal(reference.blackSignalReference.outcomes.length, 4);
  assert.equal(reference.blackSignalReference.risk.continuation.maxRides, 2);
  assert.equal(typeof compatibility.compareCompatibilityCorpus, 'function');
  assert.equal(report.ok, true);
  assert.equal(report.activationReady, false);
  assert.deepEqual(report.checked, {
    vectors: 64,
    posteriorCheckpoints: 256,
    economicCases: 4096,
    capCases: 4,
  });
  assert.deepEqual(report.classifications, {
    exact: 7286,
    'expected-migration-delta': 1370,
    'host-managed': 1,
    'unexpected-delta': 0,
    'target-drift': 0,
  });

  console.log(
    JSON.stringify({
      ok: true,
      packageVersion: packageManifest.version,
      corpus: { export: './compatibility/corpora/black-signal-v1.json', sha256: corpusSha256 },
      compatibility: {
        ok: report.ok,
        activationReady: report.activationReady,
        checked: report.checked,
        classifications: report.classifications,
      },
      exports: [
        '.',
        './api',
        './core',
        './protocol',
        './serialization',
        './conformance',
        './integration',
        './reference',
        './compatibility',
        './compatibility/corpora/black-signal-v1.json',
      ],
      packedFiles: files.length,
    }),
  );
} finally {
  rmSync(directory, { force: true, recursive: true });
}
