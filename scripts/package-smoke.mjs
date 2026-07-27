import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await import('../dist/index.js');
const api = await import('../dist/api/index.js');
const core = await import('../dist/core/index.js');
const protocol = await import('../dist/protocol/index.js');
const serialization = await import('../dist/serialization/index.js');
const conformance = await import('../dist/conformance/index.js');
const integration = await import('../dist/integration/index.js');
const reference = await import('../dist/reference/index.js');
assert.equal(root.ENGINE_API_VERSION, 'reveal-engine/api-v1');
assert.equal(api.COMMITMENT_VERSION, 'reveal-engine/commit-v2');
assert.equal(typeof core.uniformBigInt, 'function');
assert.equal(core.commitment, undefined);
assert.equal(typeof protocol.RoundBook, 'function');
assert.equal(typeof serialization.deserializeTranscript, 'function');
assert.equal(typeof conformance.checkAdapterConformance, 'function');
assert.equal(typeof integration.RgsExample, 'function');
assert.equal(reference.blackSignalReference.outcomes.length, 4);
const directory = mkdtempSync(join(tmpdir(), 'reveal-engine-pack-'));
const result = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--cache', join(directory, 'cache')], {
    encoding: 'utf8',
  }),
);
const files = result[0].files.map((entry) => entry.path);
assert(files.includes('dist/index.js'));
assert(files.includes('dist/cli/verify.js'));
assert(!files.some((path) => path.startsWith('src/') || path.startsWith('tests/')));
console.log(
  JSON.stringify({
    ok: true,
    exports: [
      '.',
      './api',
      './core',
      './protocol',
      './serialization',
      './conformance',
      './integration',
      './reference',
    ],
    packedFiles: files.length,
  }),
);
