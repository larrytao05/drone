import { readFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRedactingWriter } from './redact-output.mjs';

const [mode, serverMode, portText] = process.argv.slice(2);
if (!['local', 'provider', 'missing'].includes(mode) || !['dev', 'start'].includes(serverMode) || !/^\d+$/.test(portText ?? '')) {
  process.stderr.write('Usage: node scripts/run-map-server.mjs <local|provider|missing> <dev|start> <port>\n');
  process.exit(2);
}

const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(cwd);
const keyName = 'MAPTILER_API_KEY';
let key = '';
if (mode === 'provider') {
  const envFile = process.env.DRONE_MAP_ENV_FILE;
  if (!envFile) throw new Error('DRONE_MAP_ENV_FILE must point to the original workspace .env.local');
  const envText = await readFile(envFile, 'utf8');
  const entry = envText.split(/\r?\n/).find((line) => line.startsWith(`${keyName}=`));
  if (entry === undefined) throw new Error('Provider key is not configured in the original workspace');
  key = entry.slice(keyName.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!key) throw new Error('Provider key is not configured in the original workspace');
}

const env = { ...process.env, DRONE_MAP_MODE: mode === 'provider' ? 'provider' : mode === 'local' ? 'local' : 'provider' };
delete env[keyName];
delete env.NEXT_PUBLIC_MAPTILER_API_KEY;
if (mode === 'provider') env[keyName] = key;
if (serverMode === 'dev') env.DRONE_NEXT_DIST_DIR = `.next-map-${mode}`;
if (serverMode === 'start') env.DRONE_NEXT_DIST_DIR = '.next';
if (serverMode === 'dev' && process.env.DRONE_PLANNER_BUILD !== 'ready') {
  const buildEnv = { ...env };
  delete buildEnv[keyName];
  delete buildEnv.NEXT_PUBLIC_MAPTILER_API_KEY;
  execFileSync('npm', ['run', 'build'], { cwd, env: buildEnv, stdio: 'inherit' });
}
await import('./prepare-maplibre-worker.mjs');
const nextBin = path.resolve(cwd, 'node_modules/next/dist/bin/next');
const nextArgs = serverMode === 'dev'
  ? [nextBin, 'dev', '--hostname', '127.0.0.1', '--port', portText]
  : [nextBin, 'start', '--hostname', '127.0.0.1', '--port', portText];
const child = spawn(process.execPath, nextArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
const redactStdout = createRedactingWriter(key, (output) => process.stdout.write(output));
const redactStderr = createRedactingWriter(key, (output) => process.stderr.write(output));
child.stdout.setEncoding('utf8').on('data', (chunk) => redactStdout(chunk));
child.stderr.setEncoding('utf8').on('data', (chunk) => redactStderr(chunk));
child.stdout.on('end', () => redactStdout('', true));
child.stderr.on('end', () => redactStderr('', true));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => process.exit(1));
child.on('close', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
