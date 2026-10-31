import { GlobalWorkerOptions, RenderingCancelledException, getDocument } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { totalRotation } from './core/geometry';
import type { PageRef } from './core/types';

GlobalWorkerOptions.workerSrc = workerUrl;

// Absolute URL: pdf.js resolves these inside its worker, not relative to the page.
const ASSETS = new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;
/** Upper bound for canvas pixels to keep memory in check on very high zoom levels. */
const MAX_PIXELS = 16_000_000;

interface HostState {
  key: string;
  task?: RenderTask;
}

/**
 * Renders pages with pdf.js. Each host element owns at most one canvas, and a render
 * is only performed when the page, rotation or size changes. New canvases replace the
 * old one only after they finished drawing, so zooming never flashes blank pages.
 */
export class Renderer {
  private docs = new Map<string, PDFDocumentLoadingTask>();
  private hosts = new WeakMap<HTMLElement, HostState>();

  add(sourceId: string, bytes: Uint8Array): void {
    // pdf.js transfers the buffer to its worker, so hand it a copy.
    const task = getDocument({
      data: bytes.slice(),
      enableXfa: false,
      cMapUrl: `${ASSETS}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${ASSETS}standard_fonts/`,
      wasmUrl: `${ASSETS}wasm/`,
      iccUrl: `${ASSETS}iccs/`,
    });
    this.docs.set(sourceId, task);
  }

  remove(sourceId: string): void {
    const task = this.docs.get(sourceId);
    this.docs.delete(sourceId);
    void task?.destroy();
  }

  /** Renders `page` into `host` so that it is `cssWidth` CSS pixels wide. */
  async draw(host: HTMLElement, page: PageRef, cssWidth: number): Promise<void> {
    const rotation = totalRotation(page);
    const width = Math.max(1, Math.round(cssWidth));
    const key = `${page.sourceId}:${page.index}:${rotation}:${width}`;
    const state = this.hosts.get(host) ?? { key: '' };
    if (state.key === key) return;
    state.task?.cancel();
    state.key = key;
    this.hosts.set(host, state);

    const status = host.querySelector<HTMLElement>('.page-status');
    if (status && !host.querySelector('canvas')) {
      status.hidden = false;
      status.innerHTML = '<span class="spinner"></span><span>Loading page...</span>';
    }
    host.setAttribute('aria-busy', 'true');
    const loading = this.docs.get(page.sourceId);
    try {
      if (!loading) throw new Error('PDF preview source is unavailable');
      const doc = await loading.promise;
      const pdfPage = await doc.getPage(page.index + 1);
      if (state.key !== key) return;
      const base = pdfPage.getViewport({ scale: 1, rotation });
      let scale = (width * (window.devicePixelRatio || 1)) / base.width;
      const pixels = base.width * base.height * scale * scale;
      if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
      const viewport = pdfPage.getViewport({ scale, rotation });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const task = pdfPage.render({ canvas, viewport });
      state.task = task;
      await task.promise;
      if (state.key !== key) return;
      state.task = undefined;
      const old = host.querySelector('canvas');
      if (old) old.replaceWith(canvas);
      else host.prepend(canvas);
      if (old) releaseCanvas(old);
      if (status) status.hidden = true;
      host.setAttribute('aria-busy', 'false');
    } catch (err) {
      if (err instanceof RenderingCancelledException) return;
      if (state.key === key) {
        state.key = '';
        host.setAttribute('aria-busy', 'false');
        if (status && !host.querySelector('canvas')) {
          status.hidden = false;
          status.textContent = 'Could not load this page.';
        }
      }
      console.error(err);
    }
  }

  /** Frees the canvas of a host that scrolled far out of view. */
  release(host: HTMLElement): void {
    const state = this.hosts.get(host);
    if (state) {
      state.task?.cancel();
      state.key = '';
      state.task = undefined;
    }
    const canvas = host.querySelector('canvas');
    if (canvas) {
      canvas.remove();
      releaseCanvas(canvas);
    }
    host.setAttribute('aria-busy', 'false');
    const status = host.querySelector<HTMLElement>('.page-status');
    if (status) {
      status.hidden = false;
      status.innerHTML = '<span class="spinner"></span><span>Loading page...</span>';
    }
  }
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  // Shrinking the canvas lets the browser reclaim its backing store immediately.
  canvas.width = 0;
  canvas.height = 0;
}
