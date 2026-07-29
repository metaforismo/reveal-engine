import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Packs the built package, installs the tarball into a throwaway consumer, and
 * imports every advertised subpath through the package's own export map. This
 * catches an export map that only works from `dist/...` relative paths.
 */
const packageName = '@axiom-games/reveal-engine';
const subpaths = [
  '.',
  './api',
  './core',
  './modules',
  './modules/progressive-market',
  './modules/permutation',
  './conformance',
  './integration',
  './protocol',
  './serialization',
  './reference',
];
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
  assert(files.includes('dist/modules/progressive-market/index.js'));
  assert(files.includes('dist/modules/permutation/index.js'));
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
  const load = async (subpath) =>
    import(
      pathToFileURL(
        resolver.resolve(subpath === '.' ? packageName : `${packageName}/${subpath.slice(2)}`),
      ).href
    );

  const loaded = Object.fromEntries(
    await Promise.all(subpaths.map(async (subpath) => [subpath, await load(subpath)])),
  );
  const root = loaded['.'];
  const api = loaded['./api'];
  const core = loaded['./core'];
  const modules = loaded['./modules'];
  const progressiveMarket = loaded['./modules/progressive-market'];
  const permutation = loaded['./modules/permutation'];
  const conformance = loaded['./conformance'];
  const integration = loaded['./integration'];

  assert.equal(root.ENGINE_API_VERSION, 'reveal-engine/api-v1');
  assert.equal(api.MODULE_API_VERSION, 'reveal-engine/module-v1');
  assert.equal(api.COMMITMENT_VERSION, 'reveal-engine/commit-v2');
  assert.equal(typeof core.uniformBigInt, 'function');
  assert.equal(typeof core.CommandLedger, 'function');
  assert.equal(typeof core.defineLifecycleModule, 'function');
  assert.equal(core.commitment, undefined, 'core must not expose proof construction');
  assert.equal(core.defineGame, undefined, 'core must stay game-agnostic');
  assert.deepEqual(
    modules.listModules().map((module) => module.id),
    ['progressive-market', 'permutation'],
  );
  assert.equal(progressiveMarket.progressiveMarket.moduleApiVersion, 'reveal-engine/module-v1');
  assert.equal(typeof progressiveMarket.RoundBook, 'function');
  assert.equal(progressiveMarket.blackSignalReference.outcomes.length, 4);
  assert.equal(progressiveMarket.commitment, undefined);
  assert.equal(permutation.permutation.moduleApiVersion, 'reveal-engine/module-v1');
  assert.equal(permutation.permutation.truth.kind, 'permutation');
  assert.equal(permutation.aetherOrderClassicReference.items.length, 5);
  assert.equal(typeof permutation.PermutationBook, 'function');
  assert.equal(typeof conformance.checkModuleConformance, 'function');
  assert.equal(typeof integration.RgsExample, 'function');
  assert.equal(loaded['./protocol'].RoundBook, progressiveMarket.RoundBook);
  assert.equal(
    loaded['./serialization'].serializeTranscript,
    progressiveMarket.serializeTranscript,
  );
  assert.equal(loaded['./reference'].blackSignalReference, progressiveMarket.blackSignalReference);

  const report = conformance.checkModuleConformance(
    progressiveMarket.progressiveMarket,
    progressiveMarket.binaryBeaconReference,
    2,
  );
  assert.equal(report.ok, true);
  const permutationReport = conformance.checkModuleConformance(
    permutation.permutation,
    permutation.aetherOrderClassicReference,
    2,
  );
  assert.equal(permutationReport.ok, true, JSON.stringify(permutationReport.failures));

  console.log(
    JSON.stringify({
      ok: true,
      packageVersion: JSON.parse(
        execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], {
          encoding: 'utf8',
        }),
      ).version,
      exports: subpaths,
      packedFiles: files.length,
      conformance: [
        { moduleId: report.moduleId, ok: report.ok },
        { moduleId: permutationReport.moduleId, ok: permutationReport.ok },
      ],
    }),
  );
} finally {
  rmSync(directory, { force: true, recursive: true });
}
