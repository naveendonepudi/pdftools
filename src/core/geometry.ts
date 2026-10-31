import type { PageRef, Rotation } from './types';

export interface Point {
  x: number;
  y: number;
}

export function normalizeRotation(angle: number): Rotation {
  return ((((Math.round(angle / 90) * 90) % 360) + 360) % 360) as Rotation;
}

/** Total clockwise rotation used to display a page. */
export function totalRotation(page: Pick<PageRef, 'baseRotation' | 'rotation'>): Rotation {
  return normalizeRotation(page.baseRotation + page.rotation);
}

/** Size of the page as displayed (after rotation), in points. */
export function displaySize(width: number, height: number, rotation: Rotation): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

/**
 * Maps a point of the unrotated page (top-left origin, points) to the
 * displayed page (top-left origin, points) for a clockwise rotation.
 */
export function toDisplay(p: Point, width: number, height: number, rotation: Rotation): Point {
  switch (rotation) {
    case 90:
      return { x: height - p.y, y: p.x };
    case 180:
      return { x: width - p.x, y: height - p.y };
    case 270:
      return { x: p.y, y: width - p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

/** Inverse of {@link toDisplay}. */
export function fromDisplay(p: Point, width: number, height: number, rotation: Rotation): Point {
  switch (rotation) {
    case 90:
      return { x: p.y, y: height - p.x };
    case 180:
      return { x: width - p.x, y: height - p.y };
    case 270:
      return { x: width - p.y, y: p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

/**
 * Computes the lower-left anchor (in PDF user space, y-up) used to draw an image of
 * `width`×`height` centred at `centre` (top-left frame), rotated counter-clockwise by
 * `angle` degrees around its lower-left corner, as done by pdf-lib's `drawImage`.
 */
export function imageAnchor(
  centre: Point,
  width: number,
  height: number,
  angle: number,
  box: { x: number; y: number; height: number },
): Point {
  const X = box.x + centre.x;
  const Y = box.y + box.height - centre.y;
  const t = (angle * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const ox = (width / 2) * cos - (height / 2) * sin;
  const oy = (width / 2) * sin + (height / 2) * cos;
  return { x: X - ox, y: Y - oy };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
