import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceScripts = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const nextEnvPath = require.resolve('@next/env');

for (const initialPlanner of ['missing', 'stale']) {
  test(`development launcher prepares a ${initialPlanner} planner before Next starts`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'drone-map-server-'));
    const scripts = join(fixture, 'scripts');
    const npmBin = join(fixture, 'bin', 'npm');
    const maplibrePackage = join(fixture, 'node_modules', 'maplibre-gl');
    const nextBin = join(fixture, 'node_modules', 'next', 'dist', 'bin', 'next');
    const planner = join(fixture, 'dist', 'index.js');
    const events = join(fixture, 'events.log');

    try {
      await mkdir(scripts, { recursive: true });
      await mkdir(join(fixture, 'bin'), { recursive: true });
      await mkdir(maplibrePackage, { recursive: true });
      await mkdir(join(fixture, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
      await copyFile(join(sourceScripts, 'run-map-server.mjs'), join(scripts, 'run-map-server.mjs'));
      await copyFile(join(sourceScripts, 'prepare-maplibre-worker.mjs'), join(scripts, 'prepare-maplibre-worker.mjs'));
      await copyFile(join(sourceScripts, 'redact-output.mjs'), join(scripts, 'redact-output.mjs'));
      await writeFile(join(maplibrePackage, 'package.json'), JSON.stringify({ name: 'maplibre-gl', type: 'module', exports: './index.js' }));
      await writeFile(join(maplibrePackage, 'index.js'), '');
      await writeFile(join(maplibrePackage, 'maplibre-gl-worker.mjs'), 'worker');
      await writeFile(npmBin, `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
appendFileSync(process.env.LAUNCH_EVENTS, JSON.stringify({ step: 'build', mapKeyPresent: Boolean(process.env.MAPTILER_API_KEY), publicKeyPresent: Boolean(process.env.NEXT_PUBLIC_MAPTILER_API_KEY) }) + '\\n');
mkdirSync(dirname(join(process.cwd(), 'dist/index.js')), { recursive: true });
writeFileSync(join(process.cwd(), 'dist/index.js'), 'compiled');
`);
      await chmod(npmBin, 0o755);
      await writeFile(nextBin, `const { appendFileSync, readFileSync } = require('node:fs');
appendFileSync(process.env.LAUNCH_EVENTS, JSON.stringify({ step: 'next', planner: readFileSync('dist/index.js', 'utf8') }) + '\\n');
process.stdout.write('fake Next started\\n');
`);
      if (initialPlanner === 'stale') {
        await mkdir(join(fixture, 'dist'), { recursive: true });
        await writeFile(planner, 'stale');
      }

      const env = { ...process.env, PATH: `${join(fixture, 'bin')}${delimiter}${process.env.PATH}`, LAUNCH_EVENTS: events };
      delete env.MAPTILER_API_KEY;
      delete env.NEXT_PUBLIC_MAPTILER_API_KEY;
      delete env.DRONE_PLANNER_BUILD;
      execFileSync(process.execPath, [join(scripts, 'run-map-server.mjs'), 'local', 'dev', '9876'], {
        cwd: fixture,
        env,
        stdio: 'ignore',
      });

      const eventsWritten = (await readFile(events, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(eventsWritten, [
        { step: 'build', mapKeyPresent: false, publicKeyPresent: false },
        { step: 'next', planner: 'compiled' },
      ]);
      assert.equal(await readFile(join(fixture, 'public', 'maplibre-gl-worker.mjs'), 'utf8'), 'worker');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

test('missing mode keeps the provider key explicitly empty through Next dotenv loading', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'drone-map-server-missing-'));
  const scripts = join(fixture, 'scripts');
  const maplibrePackage = join(fixture, 'node_modules', 'maplibre-gl');
  const nextBin = join(fixture, 'node_modules', 'next', 'dist', 'bin', 'next');
  const events = join(fixture, 'events.log');

  try {
    await mkdir(scripts, { recursive: true });
    await mkdir(maplibrePackage, { recursive: true });
    await mkdir(join(fixture, 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
    await copyFile(join(sourceScripts, 'run-map-server.mjs'), join(scripts, 'run-map-server.mjs'));
    await copyFile(join(sourceScripts, 'prepare-maplibre-worker.mjs'), join(scripts, 'prepare-maplibre-worker.mjs'));
    await copyFile(join(sourceScripts, 'redact-output.mjs'), join(scripts, 'redact-output.mjs'));
    await writeFile(join(maplibrePackage, 'package.json'), JSON.stringify({ name: 'maplibre-gl', type: 'module', exports: './index.js' }));
    await writeFile(join(maplibrePackage, 'index.js'), '');
    await writeFile(join(maplibrePackage, 'maplibre-gl-worker.mjs'), 'worker');
    await writeFile(join(fixture, '.env.local'), 'MAPTILER_API_KEY=fixture-provider-key\n');
    await writeFile(nextBin, `const { appendFileSync } = require('node:fs');
const { loadEnvConfig } = require(${JSON.stringify(nextEnvPath)});
const keyBefore = process.env.MAPTILER_API_KEY ?? null;
loadEnvConfig(process.cwd());
appendFileSync(process.env.LAUNCH_EVENTS, JSON.stringify({ step: 'next', keyBefore, keyAfter: process.env.MAPTILER_API_KEY ?? null, mode: process.env.DRONE_MAP_MODE }) + '\\n');
`);

    const env = { ...process.env, LAUNCH_EVENTS: events, DRONE_PLANNER_BUILD: 'ready' };
    delete env.MAPTILER_API_KEY;
    delete env.NEXT_PUBLIC_MAPTILER_API_KEY;
    delete env.DRONE_MAP_ENV_FILE;
    execFileSync(process.execPath, [join(scripts, 'run-map-server.mjs'), 'missing', 'dev', '9876'], {
      cwd: fixture,
      env,
      stdio: 'ignore',
    });

    const [event] = (await readFile(events, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(event, { step: 'next', keyBefore: '', keyAfter: '', mode: 'provider' });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
