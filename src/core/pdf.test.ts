import { encryptPDF } from '@pdfsmaller/pdf-encrypt';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildPdf, createBlankPdf, createImagePdf, decryptPdfBytes, describePages, loadPdf } from './pdf';
import type { Signature } from './types';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Creates a PDF whose pages have distinct widths so they can be identified later. */
async function makePdf(widths: number[], rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const w of widths) doc.addPage([w, 500]).setRotation(degrees(rotate));
  return doc.save();
}

let counter = 0;
const makeId = () => `p${counter++}`;

async function setup() {
  const docs = new Map<string, PDFDocument>([
    ['a', await loadPdf(await makePdf([100, 200, 300]))],
    ['b', await loadPdf(await makePdf([400, 500], 90))],
  ]);
  const loader = async (id: string) => docs.get(id)!;
  const pagesA = describePages(docs.get('a')!, 'a', makeId);
  const pagesB = describePages(docs.get('b')!, 'b', makeId);
  return { loader, pagesA, pagesB };
}

async function widths(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getWidth());
}

describe('describePages', () => {
  it('reads page size and existing rotation', async () => {
    const { pagesA, pagesB } = await setup();
    expect(pagesA.map((p) => p.width)).toEqual([100, 200, 300]);
    expect(pagesA[0]).toMatchObject({ sourceId: 'a', index: 0, baseRotation: 0, rotation: 0, height: 500 });
    expect(pagesB[1]).toMatchObject({ sourceId: 'b', index: 1, baseRotation: 90 });
  });
});

describe('buildPdf', () => {
  it('merges, reorders and removes pages', async () => {
    const { loader, pagesA, pagesB } = await setup();
    const pages = [pagesB[1], pagesA[2], pagesA[0], pagesB[0]];
    expect(await widths(await buildPdf(pages, [], loader))).toEqual([500, 300, 100, 400]);
  });

  it('applies user rotation on top of the existing rotation', async () => {
    const { loader, pagesA, pagesB } = await setup();
    const pages = [{ ...pagesA[0], rotation: 90 as const }, { ...pagesB[0], rotation: 270 as const }];
    const out = await PDFDocument.load(await buildPdf(pages, [], loader));
    expect(out.getPages().map((p) => p.getRotation().angle)).toEqual([90, 0]);
  });

  it('allows the same page to be used twice', async () => {
    const { loader, pagesA } = await setup();
    expect(await widths(await buildPdf([pagesA[1], { ...pagesA[1], id: 'copy' }], [], loader))).toEqual([200, 200]);
  });

  it('stamps signatures as images on their page only', async () => {
    const { loader, pagesA } = await setup();
    const sig: Signature = {
      id: 's1',
      pageId: pagesA[1].id,
      image: `data:image/png;base64,${PNG_1X1}`,
      cx: 50,
      cy: 50,
      width: 40,
      height: 20,
      angle: 0,
    };
    const out = await PDFDocument.load(await buildPdf(pagesA, [sig, { ...sig, id: 's2' }], loader));
    const xObjects = out.getPages().map((p) => p.node.Resources()?.lookup(PDFName.of('XObject')));
    expect(xObjects[0]).toBeUndefined();
    expect(xObjects[1]).toBeDefined();
    expect(xObjects[2]).toBeUndefined();
  });
});

describe('page factories', () => {
  it('creates a blank A4 page', async () => {
    const doc = await PDFDocument.load(await createBlankPdf());
    expect(doc.getPageCount()).toBe(1);
    expect(Math.round(doc.getPage(0).getWidth())).toBe(595);
  });

  it('creates a page from an image', async () => {
    const png = Uint8Array.from(atob(PNG_1X1), (c) => c.charCodeAt(0));
    const doc = await PDFDocument.load(await createImagePdf(png, 'png'));
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getWidth()).toBe(1);
  });
});

describe('loadPdf', () => {
  it('rejects invalid data', async () => {
    await expect(loadPdf(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });

  it('opens PDFs encrypted with an empty user password and preserves form fields', async () => {
    const source = await PDFDocument.create();
    source.addPage([200, 300]);
    source.getForm().createTextField('sample.name').setText('Example');
    const encrypted = await encryptPDF(await source.save(), '', { ownerPassword: 'owner-secret' });

    const loaded = await loadPdf(encrypted);

    expect(loaded.getPageCount()).toBe(1);
    expect(loaded.getForm().getTextField('sample.name').getText()).toBe('Example');
  });

  it('reports encrypted PDFs that require a password', async () => {
    const encrypted = await encryptPDF(await createBlankPdf(), 'user-secret', { ownerPassword: 'owner-secret' });

    await expect(loadPdf(encrypted)).rejects.toMatchObject({
      name: 'EncryptedPdfError',
      message: 'This PDF requires a password.',
      passwordRequired: true,
      incorrectPassword: false,
    });
    await expect(loadPdf(encrypted, 'wrong-password')).rejects.toMatchObject({
      name: 'EncryptedPdfError',
      passwordRequired: true,
      incorrectPassword: true,
    });
    await expect(loadPdf(encrypted, 'user-secret')).resolves.toMatchObject({
      getPageCount: expect.any(Function),
    });
    const decrypted = await decryptPdfBytes(encrypted, 'user-secret');
    await expect(PDFDocument.load(decrypted)).resolves.toMatchObject({
      getPageCount: expect.any(Function),
    });
  });
});
