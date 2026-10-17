import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageEntry = fileURLToPath(import.meta.resolve('maplibre-gl'));
const publicDirectory = resolve('public');
await mkdir(publicDirectory, { recursive: true });
await copyFile(resolve(dirname(packageEntry), 'maplibre-gl-worker.mjs'), resolve(publicDirectory, 'maplibre-gl-worker.mjs'));
