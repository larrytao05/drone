import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../app/api/map-config/route.js';

afterEach(() => vi.unstubAllEnvs());

describe('runtime map configuration', () => {
  it('returns missing without a key and prevents response caching', async () => {
    vi.stubEnv('DRONE_MAP_MODE', 'provider');
    vi.stubEnv('MAPTILER_API_KEY', '');
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    await expect(response.json()).resolves.toEqual({ kind: 'missing' });
  });

  it('uses local mode even when the server has a provider key', async () => {
    vi.stubEnv('DRONE_MAP_MODE', 'local');
    vi.stubEnv('MAPTILER_API_KEY', 'dummy-fixture');
    const response = await GET();

    await expect(response.json()).resolves.toEqual({ kind: 'local' });
  });

  it('returns a runtime provider style URL without a public build variable', async () => {
    vi.stubEnv('DRONE_MAP_MODE', 'provider');
    vi.stubEnv('MAPTILER_API_KEY', 'dummy&fixture');
    const response = await GET();

    await expect(response.json()).resolves.toEqual({
      kind: 'provider',
      styleUrl: 'https://api.maptiler.com/maps/hybrid-v4/style.json?key=dummy%26fixture',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
  });

  it('rejects unknown modes with a no-store server error', async () => {
    vi.stubEnv('DRONE_MAP_MODE', 'unsupported');
    const response = await GET();

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
  });
});
