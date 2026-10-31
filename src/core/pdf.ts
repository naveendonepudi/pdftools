import { PDFDocument, PageSizes, degrees, popGraphicsState, pushGraphicsState } from 'pdf-lib';
import type { PDFImage, PDFPage } from 'pdf-lib';
import { imageAnchor, normalizeRotation } from './geometry';
import type { PageRef, Signature } from './types';

export type DocLoader = (sourceId: string) => Promise<PDFDocument>;

export class EncryptedPdfError extends Error {
  constructor() {
    super('This PDF is password-protected. Please remove the password and try again.');
    this.name = 'EncryptedPdfError';
  }
}

/** Parses PDF bytes with pdf-lib. Throws {@link EncryptedPdfError} for protected files. */
export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof Error && /encrypted/i.test(err.message)) throw new EncryptedPdfError();
    throw err;
  }
}

/** Creates page references for every page of a parsed source document. */
export function describePages(doc: PDFDocument, sourceId: string, makeId: () => string): PageRef[] {
  return doc.getPages().map((page, index) => {
    const box = page.getCropBox();
    return {
      id: makeId(),
      sourceId,
      index,
      baseRotation: normalizeRotation(page.getRotation().angle),
      rotation: 0,
      width: box.width,
      height: box.height,
    };
  });
}

/** Creates a one-page PDF containing a blank page of the given size (points). */
export async function createBlankPdf(width = PageSizes.A4[0], height = PageSizes.A4[1]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  return doc.save();
}

/**
 * Creates a one-page PDF that shows a PNG or JPEG image. The page is sized to the
 * image, scaled down (never up) to fit within an A4 page of matching orientation.
 */
export async function createImagePdf(bytes: Uint8Array, type: 'png' | 'jpg'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const image = type === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const [a4w, a4h] = PageSizes.A4;
  const landscape = image.width > image.height;
  const maxW = landscape ? a4h : a4w;
  const maxH = landscape ? a4w : a4h;
  const scale = Math.min(1, maxW / image.width, maxH / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const page = doc.addPage([width, height]);
  page.drawImage(image, { x: 0, y: 0, width, height });
  return doc.save();
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; type: 'png' | 'jpg' } {
  const match = /^data:image\/(png|jpe?g);base64,(.*)$/i.exec(dataUrl);
  if (!match) throw new Error('Unsupported signature image');
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, type: match[1].toLowerCase() === 'png' ? 'png' : 'jpg' };
}

/** Isolates the existing page content so that new drawing uses a clean graphics state. */
function isolateExistingContent(page: PDFPage): void {
  const { context } = page.doc;
  page.node.normalize();
  const start = context.register(context.contentStream([pushGraphicsState()]));
  const end = context.register(context.contentStream([popGraphicsState()]));
  page.node.wrapContentStreams(start, end);
}

/**
 * Builds a new PDF from the working document: pages are copied in order from their
 * source documents, user rotation is applied and signatures are stamped on top.
 */
export async function buildPdf(
  pages: PageRef[],
  signatures: Signature[],
  loader: DocLoader,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();

  // Copy pages in one batch per source so that shared resources are copied once.
  const bySource = new Map<string, number[]>();
  pages.forEach((page, slot) => {
    const slots = bySource.get(page.sourceId) ?? [];
    slots.push(slot);
    bySource.set(page.sourceId, slots);
  });
  const copied: PDFPage[] = new Array(pages.length);
  for (const [sourceId, slots] of bySource) {
    const src = await loader(sourceId);
    const result = await out.copyPages(
      src,
      slots.map((slot) => pages[slot].index),
    );
    slots.forEach((slot, i) => (copied[slot] = result[i]));
  }

  const signaturesByPage = new Map<string, Signature[]>();
  for (const sig of signatures) {
    const list = signaturesByPage.get(sig.pageId) ?? [];
    list.push(sig);
    signaturesByPage.set(sig.pageId, list);
  }
  const images = new Map<string, PDFImage>();

  for (let i = 0; i < pages.length; i++) {
    const ref = pages[i];
    const page = out.addPage(copied[i]);
    page.setRotation(degrees(normalizeRotation(ref.baseRotation + ref.rotation)));

    const sigs = signaturesByPage.get(ref.id);
    if (!sigs?.length) continue;
    isolateExistingContent(page);
    const box = page.getCropBox();
    for (const sig of sigs) {
      let image = images.get(sig.image);
      if (!image) {
        const { bytes, type } = dataUrlToBytes(sig.image);
        image = type === 'png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        images.set(sig.image, image);
      }
      const anchor = imageAnchor({ x: sig.cx, y: sig.cy }, sig.width, sig.height, sig.angle, box);
      page.drawImage(image, {
        x: anchor.x,
        y: anchor.y,
        width: sig.width,
        height: sig.height,
        rotate: degrees(sig.angle),
      });
    }
  }

  return out.save();
}
