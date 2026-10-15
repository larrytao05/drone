import { vi } from 'vitest';

class TestResizeObserver implements ResizeObserver {
  observe() {}

  unobserve() {}

  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver;

vi.mock('maplibre-gl', () => import('./maplibre-double'));
