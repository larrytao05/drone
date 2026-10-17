import { describe, expect, it } from 'vitest';
import { parseNumericText } from '../../web/numeric-input.js';

describe('shared numeric source parser', () => {
  it.each([
    ['37.5', 37.5],
    ['.5', 0.5],
    ['1.', 1],
    ['1e2', 100],
    ['-0', -0],
  ])('parses %s as a finite decimal', (text, expected) => {
    expect(parseNumericText(text)).toBe(expected);
  });

  it.each(['', '-', '.', '1e', 'Infinity', 'NaN', '0x10'])('rejects incomplete or non-decimal input %s', (text) => {
    expect(parseNumericText(text)).toBeNull();
  });
});
