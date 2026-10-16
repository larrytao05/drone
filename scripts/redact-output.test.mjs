import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRedactingWriter } from './redact-output.mjs';

test('redacts a key split across output chunks before writing complete lines', () => {
  const output = [];
  const write = createRedactingWriter('dummy-secret', (value) => output.push(value));
  write('request https://example.test/?key=dummy-');
  write('secret\npartial dummy-secret');
  write('', true);
  assert.equal(output.join(''), 'request https://example.test/?key=[redacted]\npartial [redacted]');
});

test('redacted command launcher works on an integrated branch', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'drone-launcher-'));
  const scripts = join(fixture, 'scripts');
  const sourceScripts = fileURLToPath(new URL('.', import.meta.url));
  await mkdir(scripts, { recursive: true });
  await copyFile(join(sourceScripts, 'run-redacted-command.mjs'), join(scripts, 'run-redacted-command.mjs'));
  await copyFile(join(sourceScripts, 'redact-output.mjs'), join(scripts, 'redact-output.mjs'));

  try {
    execFileSync('git', ['init', '--initial-branch=integrated'], { cwd: fixture, stdio: 'ignore' });
    const output = execFileSync(process.execPath, [
      join(scripts, 'run-redacted-command.mjs'),
      process.execPath,
      '-e',
      "process.stdout.write('launched')",
    ], { cwd: fixture, encoding: 'utf8' });
    assert.equal(output, 'launched');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
