import { describe, expect, it } from 'vitest';
import { normaliseMapCoordinate } from '../../web/map-geometry.js';

describe('map event longitude normalization', () => {
  it.each([
    [181, -179],
    [-181, 179],
    [541, -179],
    [-541, 179],
    [180, 180],
    [-180, -180],
  ])('wraps %s degrees into the displayed world', (longitudeDeg, expected) => {
    expect(normaliseMapCoordinate({ latitudeDeg: 37, longitudeDeg })).toEqual({
      latitudeDeg: 37,
      longitudeDeg: expected,
    });
  });

  it('keeps latitude unchanged while wrapping world copies', () => {
    expect(normaliseMapCoordinate({ latitudeDeg: 0, longitudeDeg: 722 })).toEqual({
      latitudeDeg: 0,
      longitudeDeg: 2,
    });
  });
});
