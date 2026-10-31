export type Rotation = 0 | 90 | 180 | 270;

/** A page in the working document. Pages reference a page of a loaded source file. */
export interface PageRef {
  /** Unique, stable id for this page in the working document. */
  id: string;
  /** Id of the source file this page comes from. */
  sourceId: string;
  /** Zero-based page index inside the source file. */
  index: number;
  /** Rotation that the source file already applies to the page (/Rotate). */
  baseRotation: Rotation;
  /** Extra clockwise rotation applied by the user. */
  rotation: Rotation;
  /** Unrotated width of the visible page area, in PDF points. */
  width: number;
  /** Unrotated height of the visible page area, in PDF points. */
  height: number;
}

/**
 * A signature (image) placed on a page.
 * Coordinates are in PDF points in the *unrotated* page frame, measured from the
 * top-left corner of the visible page area.
 */
export interface Signature {
  id: string;
  pageId: string;
  /** PNG or JPEG data URL. */
  image: string;
  /** Centre of the image. */
  cx: number;
  cy: number;
  /** Size of the (upright) image in points. */
  width: number;
  height: number;
  /**
   * Clockwise rotation of the page view when the signature was placed. The image is
   * drawn so that it reads upright when the page is displayed with this rotation.
   */
  angle: Rotation;
}

export interface DocState {
  pages: PageRef[];
  signatures: Signature[];
}
