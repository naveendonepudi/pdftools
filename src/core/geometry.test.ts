import { describe, expect, it } from 'vitest';
import { displaySize, fromDisplay, imageAnchor, normalizeRotation, toDisplay, totalRotation } from './geometry';
import type { Rotation } from './types';

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

describe('normalizeRotation', () => {
  it('wraps angles into 0/90/180/270', () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
    expect(totalRotation({ baseRotation: 270, rotation: 180 })).toBe(90);
  });
});

describe('display mapping', () => {
  const W = 600;
  const H = 800;

  it('swaps dimensions for quarter turns', () => {
    expect(displaySize(W, H, 0)).toEqual({ width: W, height: H });
    expect(displaySize(W, H, 90)).toEqual({ width: H, height: W });
  });

  it.each(ROTATIONS)('round-trips points at %i°', (r) => {
    const p = { x: 123, y: 456 };
    const d = toDisplay(p, W, H, r);
    const size = displaySize(W, H, r);
    expect(d.x).toBeGreaterThanOrEqual(0);
    expect(d.x).toBeLessThanOrEqual(size.width);
    expect(d.y).toBeGreaterThanOrEqual(0);
    expect(d.y).toBeLessThanOrEqual(size.height);
    expect(fromDisplay(d, W, H, r)).toEqual(p);
  });

  it('maps the unrotated top-left corner like a clockwise page rotation', () => {
    const origin = { x: 0, y: 0 };
    expect(toDisplay(origin, W, H, 90)).toEqual({ x: H, y: 0 }); // top-right
    expect(toDisplay(origin, W, H, 180)).toEqual({ x: W, y: H }); // bottom-right
    expect(toDisplay(origin, W, H, 270)).toEqual({ x: 0, y: W }); // bottom-left
  });
});

describe('imageAnchor', () => {
  it.each(ROTATIONS)('keeps the image centred after a %i° rotation', (angle) => {
    const box = { x: 10, y: 20, height: 800 };
    const centre = { x: 200, y: 300 };
    const w = 120;
    const h = 40;
    const a = imageAnchor(centre, w, h, angle, box);
    // Centre of the image after pdf-lib rotates it CCW around the anchor.
    const t = (angle * Math.PI) / 180;
    const cx = a.x + (w / 2) * Math.cos(t) - (h / 2) * Math.sin(t);
    const cy = a.y + (w / 2) * Math.sin(t) + (h / 2) * Math.cos(t);
    expect(cx).toBeCloseTo(box.x + centre.x);
    expect(cy).toBeCloseTo(box.y + box.height - centre.y);
  });
});
