import type { PDFDocument } from 'pdf-lib';
import { zipSync } from 'fflate';
import { clamp, displaySize, fromDisplay, toDisplay, totalRotation } from './core/geometry';
import { buildPdf, createBlankPdf, createImagePdf, describePages, EncryptedPdfError, loadPdfSource } from './core/pdf';
import { formatPages } from './core/ranges';
import { DocStore, insertPages, movePages, removePages, rotatePages } from './core/store';
import type { DocState, PageRef, Signature } from './core/types';
import { Renderer } from './render';
import { openInsertDialog, openPdfPasswordDialog, openPrivacyDialog, openSplitDialog } from './ui/dialogs';
import { $, downloadBlob, isTyping, pickFiles, toast, withBusy } from './ui/dom';
import { icon } from './ui/icons';
import { openSignaturePad } from './ui/signature';

const ACCEPT = 'application/pdf,.pdf,image/*';
const THUMB_WIDTH = 132;
const PAGE_GAP = 24;
/** CSS pixels per PDF point at 100% (a point is 1/72 inch, a CSS pixel 1/96 inch). */
const ACTUAL_SIZE = 96 / 72;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

/** Modifier key label used in hints (⌘ on Apple devices, Ctrl+ elsewhere). */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

let idCounter = 0;
const uid = (prefix: string) => `${prefix}${(++idCounter).toString(36)}`;

type FileKind = 'pdf' | 'png' | 'jpg' | 'image' | 'unknown';

function sniff(bytes: Uint8Array, mime: string): FileKind {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (mime.startsWith('image/')) return 'image';
  return 'unknown';
}

/** Converts any image format the browser can decode (WebP, GIF, BMP, …) to PNG. */
async function imageToPng(file: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not convert image');
  return new Uint8Array(await blob.arrayBuffer());
}

function baseName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-').trim();
  return base || 'document';
}

export class App {
  private store = new DocStore();
  private renderer = new Renderer();
  private docs = new Map<string, PDFDocument>();
  private pageById = new Map<string, PageRef>();
  private sigsByPage = new Map<string, Signature[]>();
  private fileName = 'document';

  private selection = new Set<string>();
  private anchorId: string | null = null;
  private currentId: string | null = null;
  private focusedSigId: string | null = null;

  private scale = ACTUAL_SIZE;
  private fitWidth = false;

  private thumbEls = new Map<string, HTMLElement>();
  private pageEls = new Map<string, HTMLElement>();
  private visibleThumbs = new Set<HTMLElement>();
  private visiblePages = new Set<HTMLElement>();
  private draggingPages = false;

  private readonly appEl = $('#app');
  private readonly viewer = $('#viewer');
  private readonly pagesEl = $('#pages');
  private readonly sidebar = $('#sidebar');
  private readonly thumbsEl = $('#thumbs');
  private readonly dropIndicator = $('#drop-indicator');

  private readonly pageObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        if (entry.isIntersecting) {
          this.visiblePages.add(el);
          this.drawPage(el);
        } else {
          this.visiblePages.delete(el);
          this.renderer.release(el);
        }
      }
    },
    { root: this.viewer, rootMargin: '100% 0px' },
  );

  private readonly thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        if (entry.isIntersecting) {
          this.visibleThumbs.add(el);
          this.drawThumb(el);
        } else {
          this.visibleThumbs.delete(el);
        }
      }
    },
    { root: this.thumbsEl, rootMargin: '400px 0px' },
  );

  constructor() {
    this.store.subscribe((state) => this.onState(state));
    this.bindToolbar();
    this.bindSidebar();
    this.bindViewer();
    this.bindGlobal();
    this.updateToolbar();
  }

  private get state(): DocState {
    return this.store.state;
  }

  private get hasDoc(): boolean {
    return this.state.pages.length > 0;
  }

  /* ================================================================ files */

  private async loadFile(file: File, password = ''): Promise<PageRef[]> {
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    const kind = sniff(bytes, file.type);
    if (kind === 'png' || kind === 'jpg') bytes = await createImagePdf(bytes, kind);
    else if (kind === 'image') bytes = await createImagePdf(await imageToPng(file), 'png');
    else if (kind !== 'pdf') throw new Error('is not a PDF or image');
    const source = await loadPdfSource(bytes, password);
    const doc = source.doc;
    if (doc.getPageCount() === 0) throw new Error('has no pages');
    const sourceId = uid('s');
    this.docs.set(sourceId, doc);
    this.renderer.add(sourceId, source.bytes);
    return describePages(doc, sourceId, () => uid('p'));
  }

  private async importFiles(files: File[]): Promise<PageRef[]> {
    const attempts = await Promise.all(
      files.map(async (file) => {
        try {
          return { pages: await this.loadFile(file) };
        } catch (error) {
          return { error };
        }
      }),
    );
    const results: PageRef[][] = [];

    for (let index = 0; index < files.length; index++) {
      const attempt = attempts[index];
      if (attempt.pages !== undefined) {
        results.push(attempt.pages);
        continue;
      }

      let error: unknown = attempt.error;
      let canceled = false;
      while (error instanceof EncryptedPdfError && error.passwordRequired) {
        const password = await openPdfPasswordDialog(files[index].name, error.incorrectPassword);
        if (password === null) {
          canceled = true;
          break;
        }
        try {
          results.push(await this.loadFile(files[index], password));
          error = null;
        } catch (retryError) {
          error = retryError;
        }
      }

      if (canceled) {
        results.push([]);
      } else if (error !== null) {
        this.reportImportError(files[index], error);
        results.push([]);
      }
    }

    return results.flat();
  }

  private reportImportError(file: File, error: unknown): void {
    if (!(error instanceof EncryptedPdfError)) console.error(error);
    const detail =
      error instanceof EncryptedPdfError
        ? error.passwordRequired
          ? 'needs a valid password to open.'
          : 'uses encryption this editor cannot process.'
        : error instanceof Error && /^(is|has) /.test(error.message)
          ? error.message
          : "couldn't be opened. Is it a valid PDF?";
    toast(`“${file.name}” ${detail}`, 'error', 5000);
  }

  /** Opens files as a new document (several files are merged in order). */
  async open(files: File[]): Promise<void> {
    if (!files.length) return;
    if (this.hasDoc && this.store.isDirty && !confirm('Open a new document? Your unsaved changes will be lost.')) return;
    await withBusy('Opening…', async () => {
      const oldSources = [...this.docs.keys()];
      const pages = await this.importFiles(files);
      if (!pages.length) return;
      for (const id of oldSources) {
        this.docs.delete(id);
        this.renderer.remove(id);
      }
      this.fileName = baseName(files[0].name);
      this.scale = ACTUAL_SIZE;
      this.fitWidth = false;
      this.selection = new Set([pages[0].id]);
      this.anchorId = pages[0].id;
      this.currentId = pages[0].id;
      this.store.reset({ pages, signatures: [] });
      this.viewer.scrollTo(0, 0);
      this.thumbsEl.scrollTo(0, 0);
      if (files.length > 1) toast(`Merged ${files.length} files · ${pages.length} pages`, 'success');
    });
  }

  /** Adds files at position `at` (default: end of the document). */
  async addFiles(files: File[], at = this.state.pages.length): Promise<void> {
    if (!files.length) return;
    if (!this.hasDoc) return this.open(files);
    await withBusy('Adding pages…', async () => {
      const pages = await this.importFiles(files);
      if (!pages.length) return;
      this.insert(pages, at);
      toast(`Added ${pages.length} page${pages.length === 1 ? '' : 's'} · drag thumbnails to reorder`, 'success');
    });
  }

  private insert(pages: PageRef[], at: number): void {
    this.store.update((s) => insertPages(s, at, pages));
    this.select(pages.map((p) => p.id));
    this.scrollToPage(pages[0].id);
  }

  private async insertBlank(at: number, size: { width: number; height: number }): Promise<void> {
    const pages = await this.importFiles([new File([await createBlankPdf(size.width, size.height) as Uint8Array<ArrayBuffer>], 'blank.pdf', { type: 'application/pdf' })]);
    if (pages.length) this.insert(pages, at);
  }

  /* ============================================================== actions */

  private selectedIds(): string[] {
    return this.state.pages.filter((p) => this.selection.has(p.id)).map((p) => p.id);
  }

  deleteSelected(): void {
    const ids = this.selectedIds();
    if (!ids.length) return;
    if (ids.length === this.state.pages.length) {
      toast("A PDF needs at least one page — select fewer pages to delete.", 'error');
      return;
    }
    const firstIndex = this.state.pages.findIndex((p) => this.selection.has(p.id));
    this.store.update((s) => removePages(s, ids));
    const next = this.state.pages[Math.min(firstIndex, this.state.pages.length - 1)];
    this.select([next.id]);
    toast(`Deleted ${ids.length} page${ids.length === 1 ? '' : 's'} · ${MOD}Z to undo`);
  }

  rotateSelected(delta: 90 | -90): void {
    const ids = this.selectedIds();
    if (ids.length) this.store.update((s) => rotatePages(s, ids, delta));
  }

  undo(): void {
    this.store.undo();
  }

  redo(): void {
    this.store.redo();
  }

  async download(): Promise<void> {
    if (!this.hasDoc) return;
    try {
      const bytes = await withBusy('Preparing your PDF…', () => buildPdf(this.state.pages, this.state.signatures, this.loader));
      downloadBlob(bytes, `${this.fileName}.pdf`);
      this.store.markSaved();
      toast('PDF ready — saved to your downloads', 'success');
    } catch (err) {
      console.error(err);
      toast("Sorry, this PDF couldn't be saved.", 'error');
    }
  }

  private loader = async (sourceId: string): Promise<PDFDocument> => {
    const doc = this.docs.get(sourceId);
    if (!doc) throw new Error('Missing source document');
    return doc;
  };

  private async split(groups: number[][]): Promise<void> {
    try {
      await withBusy('Splitting…', async () => {
        const { pages, signatures } = this.state;
        const files: { name: string; bytes: Uint8Array }[] = [];
        for (const group of groups) {
          const bytes = await buildPdf(
            group.map((i) => pages[i]),
            signatures,
            this.loader,
          );
          files.push({ name: `${this.fileName}-pages-${formatPages(group).replace(/, /g, '_')}.pdf`, bytes });
        }
        if (files.length === 1) {
          downloadBlob(files[0].bytes, files[0].name);
        } else {
          // PDFs are already compressed, so store them as-is for speed.
          const zip = zipSync(Object.fromEntries(files.map((f) => [f.name, [f.bytes, { level: 0 }]])));
          downloadBlob(zip, `${this.fileName}-split.zip`, 'application/zip');
        }
        toast(`Created ${files.length} PDF${files.length === 1 ? '' : 's'}`, 'success');
      });
    } catch (err) {
      console.error(err);
      toast("Sorry, the PDF couldn't be split.", 'error');
    }
  }

  async sign(): Promise<void> {
    const target = this.currentId && this.pageById.get(this.currentId);
    if (!target) return;
    const sig = await openSignaturePad();
    if (!sig) return;
    const page = this.pageById.get(target.id);
    if (!page) return;

    const rotation = totalRotation(page);
    const shown = displaySize(page.width, page.height, rotation);
    let width = shown.width * 0.3;
    let height = width / sig.aspect;
    if (height > shown.height * 0.12) {
      height = shown.height * 0.12;
      width = height * sig.aspect;
    }

    // Place the signature in the middle of the visible part of the page.
    const el = this.pageEls.get(page.id)!;
    const pageRect = el.getBoundingClientRect();
    const viewRect = this.viewer.getBoundingClientRect();
    const top = Math.max(pageRect.top, viewRect.top);
    const bottom = Math.min(pageRect.bottom, viewRect.bottom);
    const centreY = bottom > top ? ((top + bottom) / 2 - pageRect.top) / this.scale : shown.height / 2;
    const display = {
      x: shown.width / 2,
      y: clamp(centreY, height / 2, shown.height - height / 2),
    };
    const centre = fromDisplay(display, page.width, page.height, rotation);
    const signature: Signature = {
      id: uid('g'),
      pageId: page.id,
      image: sig.image,
      cx: centre.x,
      cy: centre.y,
      width,
      height,
      angle: rotation,
    };
    this.focusedSigId = signature.id;
    this.store.update((s) => ({ ...s, signatures: [...s.signatures, signature] }));
    toast('Drag to move · use the corner to resize');
  }

  private updateSignature(id: string, change: Partial<Signature> | null): void {
    this.store.update((s) => ({
      ...s,
      signatures: change
        ? s.signatures.map((sig) => (sig.id === id ? { ...sig, ...change } : sig))
        : s.signatures.filter((sig) => sig.id !== id),
    }));
  }

  /* ============================================================ selection */

  private select(ids: string[], anchor: string | null = ids[0] ?? null): void {
    this.selection = new Set(ids);
    this.anchorId = anchor;
    this.updateSelection();
  }

  private updateSelection(): void {
    for (const [id, el] of this.thumbEls) {
      const selected = this.selection.has(id);
      el.classList.toggle('selected', selected);
      el.setAttribute('aria-selected', String(selected));
      el.classList.toggle('current', id === this.currentId);
    }
    this.updateToolbar();
  }

  private setCurrent(id: string | null): void {
    if (id === this.currentId) return;
    this.currentId = id;
    if (id && this.selection.size <= 1) {
      this.selection = new Set([id]);
      this.anchorId = id;
    }
    this.updateSelection();
    if (id) this.thumbEls.get(id)?.scrollIntoView({ block: 'nearest' });
  }

  /* ============================================================ rendering */

  private onState(state: DocState): void {
    this.appEl.classList.toggle('is-empty', !state.pages.length);
    this.pageById = new Map(state.pages.map((p) => [p.id, p]));
    this.sigsByPage = new Map();
    for (const sig of state.signatures) {
      const list = this.sigsByPage.get(sig.pageId) ?? [];
      list.push(sig);
      this.sigsByPage.set(sig.pageId, list);
    }
    for (const id of this.selection) if (!this.pageById.has(id)) this.selection.delete(id);
    if (this.currentId && !this.pageById.has(this.currentId)) this.currentId = null;
    if (!this.currentId && state.pages.length) this.currentId = state.pages[0].id;

    if (this.fitWidth) this.scale = this.fitScale();
    this.syncThumbs();
    this.syncPages();
    this.updateSelection();
    this.updateCurrentFromScroll();
  }

  private syncThumbs(): void {
    const { pages } = this.state;
    const keep = new Set<string>();
    pages.forEach((page, i) => {
      keep.add(page.id);
      let el = this.thumbEls.get(page.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'thumb';
        el.dataset.id = page.id;
        el.draggable = true;
        el.setAttribute('role', 'option');
        el.innerHTML = `<div class="thumb-page"><div class="sig-layer"></div></div><span class="thumb-label"></span>`;
        this.thumbEls.set(page.id, el);
        this.thumbObserver.observe(el);
      }
      const shown = displaySize(page.width, page.height, totalRotation(page));
      const box = el.firstElementChild as HTMLElement;
      const height = Math.round((THUMB_WIDTH * shown.height) / shown.width);
      box.style.width = `${THUMB_WIDTH}px`;
      box.style.height = `${height}px`;
      el.querySelector('.thumb-label')!.textContent = String(i + 1);
      el.setAttribute('aria-label', `Page ${i + 1}`);
      if (this.thumbsEl.children[i] !== el) this.thumbsEl.insertBefore(el, this.thumbsEl.children[i] ?? null);
      this.renderSignatures(box, page, THUMB_WIDTH / shown.width, false);
      if (this.visibleThumbs.has(el)) this.drawThumb(el);
    });
    for (const [id, el] of this.thumbEls) {
      if (keep.has(id)) continue;
      this.thumbObserver.unobserve(el);
      this.visibleThumbs.delete(el);
      this.renderer.release(el.firstElementChild as HTMLElement);
      el.remove();
      this.thumbEls.delete(id);
    }
  }

  private drawThumb(el: HTMLElement): void {
    const page = this.pageById.get(el.dataset.id!);
    if (page) void this.renderer.draw(el.firstElementChild as HTMLElement, page, THUMB_WIDTH);
  }

  private syncPages(): void {
    const { pages } = this.state;
    const keep = new Set<string>();
    pages.forEach((page, i) => {
      keep.add(page.id);
      let el = this.pageEls.get(page.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'page';
        el.dataset.id = page.id;
        el.innerHTML = '<div class="page-status" role="status"><span class="spinner"></span><span>Loading page...</span></div><div class="sig-layer"></div>';
        this.pageEls.set(page.id, el);
        this.pageObserver.observe(el);
      }
      const shown = displaySize(page.width, page.height, totalRotation(page));
      el.style.width = `${Math.round(shown.width * this.scale)}px`;
      el.style.height = `${Math.round(shown.height * this.scale)}px`;
      el.setAttribute('aria-label', `Page ${i + 1}`);
      if (this.pagesEl.children[i] !== el) this.pagesEl.insertBefore(el, this.pagesEl.children[i] ?? null);
      this.renderSignatures(el, page, this.scale, true);
      if (this.visiblePages.has(el)) this.drawPage(el);
    });
    for (const [id, el] of this.pageEls) {
      if (keep.has(id)) continue;
      this.pageObserver.unobserve(el);
      this.visiblePages.delete(el);
      this.renderer.release(el);
      el.remove();
      this.pageEls.delete(id);
    }
  }

  private drawPage(el: HTMLElement): void {
    const page = this.pageById.get(el.dataset.id!);
    if (!page) return;
    const shown = displaySize(page.width, page.height, totalRotation(page));
    void this.renderer.draw(el, page, Math.round(shown.width * this.scale));
  }

  /** Renders the signature overlays of a page (cheap DOM; skipped when unchanged). */
  private renderSignatures(host: HTMLElement, page: PageRef, scale: number, interactive: boolean): void {
    const layer = host.querySelector<HTMLElement>('.sig-layer')!;
    const sigs = this.sigsByPage.get(page.id) ?? [];
    const rotation = totalRotation(page);
    const key = `${scale}|${rotation}|${sigs.map((s) => `${s.id}:${s.cx}:${s.cy}:${s.width}`).join(',')}`;
    if (layer.dataset.key === key) return;
    layer.dataset.key = key;
    layer.replaceChildren(
      ...sigs.map((sig) => {
        const el = document.createElement('div');
        el.className = 'sig';
        el.dataset.sigId = sig.id;
        this.positionSignature(el, sig, page, scale);
        const img = document.createElement('img');
        img.src = sig.image;
        img.alt = 'Signature';
        img.draggable = false;
        el.append(img);
        if (interactive) {
          el.tabIndex = 0;
          el.setAttribute('role', 'group');
          el.setAttribute('aria-label', 'Signature. Arrow keys move, Delete removes.');
          el.insertAdjacentHTML(
            'beforeend',
            `<button type="button" class="sig-delete" aria-label="Remove signature" title="Remove">${icon('close', 12)}</button><span class="sig-handle" aria-hidden="true"></span>`,
          );
          this.bindSignature(el, sig, page);
        }
        return el;
      }),
    );
    if (interactive && this.focusedSigId) {
      const focused = layer.querySelector<HTMLElement>(`[data-sig-id="${this.focusedSigId}"]`);
      focused?.focus({ preventScroll: true });
    }
  }

  private positionSignature(el: HTMLElement, sig: Pick<Signature, 'cx' | 'cy' | 'width' | 'height' | 'angle'>, page: PageRef, scale: number): void {
    const rotation = totalRotation(page);
    const centre = toDisplay({ x: sig.cx, y: sig.cy }, page.width, page.height, rotation);
    const w = sig.width * scale;
    const h = sig.height * scale;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.left = `${centre.x * scale - w / 2}px`;
    el.style.top = `${centre.y * scale - h / 2}px`;
    el.style.transform = rotation === sig.angle ? '' : `rotate(${rotation - sig.angle}deg)`;
  }

  private bindSignature(el: HTMLElement, sig: Signature, page: PageRef): void {
    const rotation = totalRotation(page);
    const shown = displaySize(page.width, page.height, rotation);

    el.addEventListener('focus', () => (this.focusedSigId = sig.id));
    el.addEventListener('blur', () => {
      if (this.focusedSigId === sig.id) this.focusedSigId = null;
    });
    el.querySelector('.sig-delete')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.updateSignature(sig.id, null);
    });
    el.querySelector('.sig-delete')!.addEventListener('pointerdown', (e) => e.stopPropagation());

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        this.updateSignature(sig.id, null);
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!delta) return;
      e.preventDefault();
      e.stopPropagation();
      const d = toDisplay({ x: sig.cx, y: sig.cy }, page.width, page.height, rotation);
      const next = fromDisplay({ x: clamp(d.x + delta[0], 0, shown.width), y: clamp(d.y + delta[1], 0, shown.height) }, page.width, page.height, rotation);
      this.updateSignature(sig.id, { cx: next.x, cy: next.y });
    });

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      el.focus({ preventScroll: true });
      el.setPointerCapture(e.pointerId);
      const resizing = (e.target as HTMLElement).classList.contains('sig-handle');
      const startX = e.clientX;
      const startY = e.clientY;
      const startCentre = toDisplay({ x: sig.cx, y: sig.cy }, page.width, page.height, rotation);
      const rect = el.getBoundingClientRect();
      const mid = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const startDist = Math.max(1, Math.hypot(startX - mid.x, startY - mid.y));
      let draft = { ...sig };
      el.classList.add('dragging');

      const move = (ev: PointerEvent) => {
        if (resizing) {
          const factor = Math.hypot(ev.clientX - mid.x, ev.clientY - mid.y) / startDist;
          const maxFactor = Math.min(shown.width, shown.height) / Math.max(sig.width, sig.height);
          const f = clamp(factor, 16 / sig.width, Math.max(1, maxFactor));
          draft = { ...draft, width: sig.width * f, height: sig.height * f };
        } else {
          const d = {
            x: clamp(startCentre.x + (ev.clientX - startX) / this.scale, 0, shown.width),
            y: clamp(startCentre.y + (ev.clientY - startY) / this.scale, 0, shown.height),
          };
          const c = fromDisplay(d, page.width, page.height, rotation);
          draft = { ...draft, cx: c.x, cy: c.y };
        }
        this.positionSignature(el, draft, page, this.scale);
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
        if (draft.cx !== sig.cx || draft.cy !== sig.cy || draft.width !== sig.width) {
          this.updateSignature(sig.id, { cx: draft.cx, cy: draft.cy, width: draft.width, height: draft.height });
        }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  /* ================================================================= zoom */

  private fitScale(): number {
    const pages = this.state.pages;
    if (!pages.length) return ACTUAL_SIZE;
    const widest = Math.max(...pages.map((p) => displaySize(p.width, p.height, totalRotation(p)).width));
    const available = this.viewer.clientWidth - PAGE_GAP * 2;
    return clamp(available / widest, 0.1, ACTUAL_SIZE * 2);
  }

  private setZoom(scale: number, fit = false, anchor?: { clientX: number; clientY: number }): void {
    const next = clamp(fit ? this.fitScale() : scale, ACTUAL_SIZE * 0.1, ACTUAL_SIZE * 5);
    this.fitWidth = fit;
    if (Math.abs(next - this.scale) < 1e-6) return this.updateToolbar();

    // Keep the point under the cursor (or the top of the current page) in place.
    const viewRect = this.viewer.getBoundingClientRect();
    const ax = anchor ? anchor.clientX - viewRect.left : 0;
    const ay = anchor ? anchor.clientY - viewRect.top : 0;
    const contentX = this.viewer.scrollLeft + ax;
    const contentY = this.viewer.scrollTop + ay;
    const target = [...this.pageEls.values()].find((el) => el.offsetTop + el.offsetHeight > contentY);
    const fy = target ? (contentY - target.offsetTop) / target.offsetHeight : 0;
    const fx = contentX / Math.max(1, this.pagesEl.scrollWidth);

    this.scale = next;
    this.syncPages();
    if (target) this.viewer.scrollTop = target.offsetTop + fy * target.offsetHeight - ay;
    this.viewer.scrollLeft = fx * this.pagesEl.scrollWidth - ax;
    this.updateToolbar();
  }

  private zoomStep(dir: 1 | -1): void {
    const pct = this.scale / ACTUAL_SIZE;
    const steps = dir > 0 ? ZOOM_STEPS.filter((s) => s > pct + 0.001) : ZOOM_STEPS.filter((s) => s < pct - 0.001).reverse();
    const next = steps[0] ?? (dir > 0 ? ZOOM_STEPS[ZOOM_STEPS.length - 1] : ZOOM_STEPS[0]);
    this.setZoom(next * ACTUAL_SIZE);
  }

  /* ============================================================ scrolling */

  private scrollToPage(id: string): void {
    const el = this.pageEls.get(id);
    if (!el) return;
    this.viewer.scrollTo({ top: el.offsetTop - PAGE_GAP / 2, behavior: 'auto' });
    this.setCurrent(id);
  }

  private updateCurrentFromScroll(): void {
    const line = this.viewer.scrollTop + this.viewer.clientHeight * 0.35;
    let current: string | null = null;
    for (const page of this.state.pages) {
      const el = this.pageEls.get(page.id)!;
      if (el.offsetTop > line) break;
      current = page.id;
    }
    this.setCurrent(current ?? this.state.pages[0]?.id ?? null);
    this.updateMeta();
  }

  /* ============================================================== toolbar */

  private updateMeta(): void {
    const total = this.state.pages.length;
    const index = this.state.pages.findIndex((p) => p.id === this.currentId);
    $('#doc-name').textContent = total ? `${this.fileName}.pdf` : 'PDF Tools';
    $('#doc-meta').textContent = total ? `Page ${index + 1} of ${total}${this.store.isDirty ? ' · Edited' : ''}` : '';
  }

  private updateToolbar(): void {
    const hasDoc = this.hasDoc;
    this.appEl.classList.toggle('is-empty', !hasDoc);
    document.querySelectorAll<HTMLButtonElement>('button[data-needs-doc]').forEach((b) => (b.disabled = !hasDoc));
    document.querySelectorAll<HTMLButtonElement>('button[data-needs-selection]').forEach((b) => (b.disabled = !hasDoc || this.selection.size === 0));
    $<HTMLButtonElement>('#btn-undo').disabled = !this.store.canUndo;
    $<HTMLButtonElement>('#btn-redo').disabled = !this.store.canRedo;
    $('#btn-zoom-fit').textContent = `${Math.round((this.scale / ACTUAL_SIZE) * 100)}%`;
    const count = this.selection.size;
    $('#btn-delete').title = count > 1 ? `Delete ${count} pages (⌫)` : 'Delete page (⌫)';
    this.updateMeta();
  }

  private bindToolbar(): void {
    const on = (id: string, fn: () => void) => $(id).addEventListener('click', fn);
    const openFiles = async () => this.open(await pickFiles(ACCEPT, true));
    on('#btn-open', openFiles);
    on('#btn-choose', openFiles);
    on('#btn-merge', async () => this.addFiles(await pickFiles(ACCEPT, true)));
    on('#btn-insert', () => {
      const index = this.state.pages.findIndex((p) => p.id === this.currentId);
      const current = this.state.pages[index] ?? this.state.pages[0];
      openInsertDialog({
        pageCount: this.state.pages.length,
        defaultAfter: index + 1,
        currentSize: { width: current.width, height: current.height },
        onFile: async (at) => this.addFiles(await pickFiles(ACCEPT, true), at),
        onBlank: (at, size) => void this.insertBlank(at, size),
      });
    });
    on('#btn-split', () => {
      const selected = this.state.pages.flatMap((p, i) => (this.selection.has(p.id) ? [i] : []));
      openSplitDialog({ pageCount: this.state.pages.length, selected, onSplit: (groups) => void this.split(groups) });
    });
    on('#btn-sign', () => void this.sign());
    on('#btn-rotate-left', () => this.rotateSelected(-90));
    on('#btn-rotate-right', () => this.rotateSelected(90));
    on('#btn-delete', () => this.deleteSelected());
    on('#btn-undo', () => this.undo());
    on('#btn-redo', () => this.redo());
    on('#btn-zoom-in', () => this.zoomStep(1));
    on('#btn-zoom-out', () => this.zoomStep(-1));
    on('#btn-zoom-fit', () => this.setZoom(0, true));
    on('#btn-download', () => void this.download());
    on('#btn-privacy', openPrivacyDialog);
    on('#btn-sidebar', () => {
      const hidden = this.appEl.classList.toggle('sidebar-hidden');
      $('#btn-sidebar').setAttribute('aria-pressed', String(!hidden));
      if (this.fitWidth) requestAnimationFrame(() => this.setZoom(0, true));
    });
  }

  /* ============================================================== sidebar */

  private dropIndexAt(clientY: number): number {
    const thumbs = [...this.thumbsEl.children] as HTMLElement[];
    for (let i = 0; i < thumbs.length; i++) {
      const r = thumbs[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return thumbs.length;
  }

  private showDropIndicator(index: number): void {
    const thumbs = [...this.thumbsEl.children] as HTMLElement[];
    const sidebarTop = this.sidebar.getBoundingClientRect().top;
    const ref = thumbs[index] ?? thumbs[thumbs.length - 1];
    if (!ref) return;
    const r = ref.getBoundingClientRect();
    const y = index < thumbs.length ? r.top - 6 : r.bottom + 2;
    this.dropIndicator.style.top = `${y - sidebarTop}px`;
    this.dropIndicator.hidden = false;
  }

  private bindSidebar(): void {
    this.thumbsEl.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.thumb');
      if (!el) return;
      const id = el.dataset.id!;
      if (e.metaKey || e.ctrlKey) {
        const next = new Set(this.selection);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        this.select([...next], id);
      } else if (e.shiftKey && this.anchorId) {
        const ids = this.state.pages.map((p) => p.id);
        const a = ids.indexOf(this.anchorId);
        const b = ids.indexOf(id);
        this.select(ids.slice(Math.min(a, b), Math.max(a, b) + 1), this.anchorId);
      } else {
        this.select([id]);
        this.scrollToPage(id);
      }
    });

    this.thumbsEl.addEventListener('keydown', (e) => {
      const ids = this.state.pages.map((p) => p.id);
      if (!ids.length) return;
      const index = ids.indexOf(this.currentId ?? ids[0]);
      const next = { ArrowDown: index + 1, ArrowRight: index + 1, ArrowUp: index - 1, ArrowLeft: index - 1, Home: 0, End: ids.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      const id = ids[clamp(next, 0, ids.length - 1)];
      if (e.shiftKey && this.anchorId) {
        const a = ids.indexOf(this.anchorId);
        const b = ids.indexOf(id);
        this.select(ids.slice(Math.min(a, b), Math.max(a, b) + 1), this.anchorId);
        this.scrollToPage(id);
      } else {
        this.select([id]);
        this.scrollToPage(id);
      }
    });

    this.thumbsEl.addEventListener('dragstart', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.thumb');
      if (!el || !e.dataTransfer) return;
      if (!this.selection.has(el.dataset.id!)) this.select([el.dataset.id!]);
      this.draggingPages = true;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `${this.selection.size} page(s)`);
      requestAnimationFrame(() => this.selection.forEach((id) => this.thumbEls.get(id)?.classList.add('drag-source')));
    });
    this.thumbsEl.addEventListener('dragend', () => {
      this.draggingPages = false;
      this.dropIndicator.hidden = true;
      this.thumbEls.forEach((el) => el.classList.remove('drag-source'));
    });

    this.sidebar.addEventListener('dragover', (e) => {
      const files = e.dataTransfer?.types.includes('Files');
      if (!this.draggingPages && !files) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = this.draggingPages ? 'move' : 'copy';
      this.showDropIndicator(this.dropIndexAt(e.clientY));
      this.hideFileOverlay();
    });
    this.sidebar.addEventListener('dragleave', (e) => {
      if (!this.sidebar.contains(e.relatedTarget as Node)) this.dropIndicator.hidden = true;
    });
    this.sidebar.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dropIndicator.hidden = true;
      const index = this.dropIndexAt(e.clientY);
      if (this.draggingPages) {
        const ids = this.selectedIds();
        this.store.update((s) => movePages(s, ids, index));
        this.draggingPages = false;
      } else if (e.dataTransfer?.files.length) {
        void this.addFiles([...e.dataTransfer.files], index);
      }
    });
  }

  /* =============================================================== viewer */

  private bindViewer(): void {
    let ticking = false;
    this.viewer.addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          this.updateCurrentFromScroll();
        });
      },
      { passive: true },
    );

    this.viewer.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey) || !this.hasDoc) return;
        e.preventDefault();
        this.setZoom(this.scale * Math.exp(-e.deltaY * 0.01), false, e);
      },
      { passive: false },
    );

    this.pagesEl.addEventListener('pointerdown', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.page');
      if (!el || (e.target as HTMLElement).closest('.sig')) return;
      this.select([el.dataset.id!]);
      this.setCurrent(el.dataset.id!);
    });

    let resizeFrame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (this.fitWidth && this.hasDoc) this.setZoom(0, true);
      });
    }).observe(this.viewer);
  }

  /* =============================================================== global */

  private fileOverlayTimer = 0;

  private hideFileOverlay(): void {
    window.clearTimeout(this.fileOverlayTimer);
    $('#file-drop-overlay').classList.remove('show');
  }

  private bindGlobal(): void {
    window.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      $('#file-drop-text').textContent = this.hasDoc ? 'Drop to add at the end' : 'Drop to open';
      $('#file-drop-overlay').classList.add('show');
      window.clearTimeout(this.fileOverlayTimer);
      this.fileOverlayTimer = window.setTimeout(() => this.hideFileOverlay(), 150);
    });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      this.hideFileOverlay();
      void this.addFiles([...e.dataTransfer.files]);
    });

    window.addEventListener('keydown', (e) => {
      if (document.querySelector('dialog[open]') || isTyping(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'o') {
        e.preventDefault();
        $('#btn-open').click();
      } else if (mod && key === 's') {
        e.preventDefault();
        void this.download();
      } else if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        this.redo();
      } else if (mod && key === 'a' && this.hasDoc) {
        e.preventDefault();
        this.select(this.state.pages.map((p) => p.id));
      } else if (mod && (key === '=' || key === '+')) {
        e.preventDefault();
        this.zoomStep(1);
      } else if (mod && key === '-') {
        e.preventDefault();
        this.zoomStep(-1);
      } else if (mod && key === '0') {
        e.preventDefault();
        this.setZoom(0, true);
      } else if ((key === 'delete' || key === 'backspace') && this.hasDoc) {
        e.preventDefault();
        this.deleteSelected();
      }
    });

    window.addEventListener('beforeunload', (e) => {
      if (this.hasDoc && this.store.isDirty) e.preventDefault();
    });
  }
}
