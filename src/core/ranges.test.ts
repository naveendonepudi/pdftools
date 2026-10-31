import { describe, expect, it } from 'vitest';
import { chunkPages, formatPages, parseRanges } from './ranges';

describe('parseRanges', () => {
  it('parses single pages and ranges into zero-based groups', () => {
    expect(parseRanges('1-3, 5', 10)).toEqual([[0, 1, 2], [4]]);
  });

  it('supports open ended ranges', () => {
    expect(parseRanges('8-', 10)).toEqual([[7, 8, 9]]);
    expect(parseRanges('-2', 10)).toEqual([[0, 1]]);
  });

  it('rejects invalid input with helpful messages', () => {
    expect(() => parseRanges('', 5)).toThrow(/at least one/);
    expect(() => parseRanges('abc', 5)).toThrow(/not a valid/);
    expect(() => parseRanges('4-2', 5)).toThrow(/starts after/);
    expect(() => parseRanges('0', 5)).toThrow(/outside/);
    expect(() => parseRanges('6', 5)).toThrow(/outside/);
  });
});

describe('chunkPages', () => {
  it('splits into fixed size chunks with a shorter tail', () => {
    expect(chunkPages(5, 2)).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('rejects invalid sizes', () => {
    expect(() => chunkPages(5, 0)).toThrow();
    expect(() => chunkPages(5, 1.5)).toThrow();
  });
});

describe('formatPages', () => {
  it('formats indices as compact one-based ranges', () => {
    expect(formatPages([4, 0, 1, 2, 7])).toBe('1-3, 5, 8');
  });
});
