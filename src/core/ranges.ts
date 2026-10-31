/**
 * Parses a human page-range expression such as `1-3, 5, 8-` into groups of
 * zero-based page indices. Each comma separated part becomes one group.
 * Throws an Error with a user friendly message when the input is invalid.
 */
export function parseRanges(input: string, pageCount: number): number[][] {
  const parts = input
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('Enter at least one page or range, e.g. 1-3, 5');

  return parts.map((part) => {
    const m = /^(\d*)\s*(?:[-–]\s*(\d*))?$/.exec(part);
    if (!m || (m[1] === '' && m[2] === undefined) || (m[1] === '' && m[2] === '')) {
      throw new Error(`“${part}” is not a valid page or range`);
    }
    const isRange = m[2] !== undefined;
    const start = m[1] === '' ? 1 : Number(m[1]);
    const end = isRange ? (m[2] === '' ? pageCount : Number(m[2])) : start;
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      throw new Error(`“${part}” is outside the document (1–${pageCount})`);
    }
    if (start > end) throw new Error(`“${part}” starts after it ends`);
    const group: number[] = [];
    for (let i = start; i <= end; i++) group.push(i - 1);
    return group;
  });
}

/** Splits `pageCount` pages into consecutive chunks of `size` pages. */
export function chunkPages(pageCount: number, size: number): number[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('Pages per file must be a whole number of at least 1');
  const groups: number[][] = [];
  for (let start = 0; start < pageCount; start += size) {
    const group: number[] = [];
    for (let i = start; i < Math.min(pageCount, start + size); i++) group.push(i);
    groups.push(group);
  }
  return groups;
}

/** Formats zero-based indices as a compact, one-based label such as `1-3, 5`. */
export function formatPages(indices: number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? `${sorted[i] + 1}` : `${sorted[i] + 1}-${sorted[j] + 1}`);
    i = j + 1;
  }
  return out.join(', ');
}
