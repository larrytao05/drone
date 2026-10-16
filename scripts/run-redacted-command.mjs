import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRedactingWriter } from './redact-output.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('A command is required');
const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)));
let key = '';
const envFile = process.env.DRONE_MAP_ENV_FILE;
if (envFile) {
  const envText = await readFile(envFile, 'utf8');
  const entry = envText.split(/\r?\n/).find((line) => line.startsWith('MAPTILER_API_KEY='));
  if (entry !== undefined) key = entry.slice('MAPTILER_API_KEY='.length).trim().replace(/^(['"])(.*)\1$/, '$2');
}

const env = { ...process.env };
delete env.MAPTILER_API_KEY;
delete env.NEXT_PUBLIC_MAPTILER_API_KEY;
const child = spawn(command, args, { cwd, stdio: ['inherit', 'pipe', 'pipe'], env });
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
