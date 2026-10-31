import { hydrateIcons, icon } from './icons';

export function $<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/* ------------------------------------------------------------------ toasts */

export function toast(message: string, kind: 'info' | 'success' | 'error' = 'info', timeout = 3500): void {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  window.setTimeout(() => {
    el.classList.remove('show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    window.setTimeout(() => el.remove(), 400);
  }, timeout);
}

/* -------------------------------------------------------------- busy state */

let busyDepth = 0;

/** Shows a blocking progress indicator while `work` runs. */
export async function withBusy<T>(message: string, work: () => Promise<T>): Promise<T> {
  const overlay = $('#busy');
  $('#busy-text').textContent = message;
  busyDepth++;
  // Only show the overlay for operations that take a noticeable amount of time.
  const timer = window.setTimeout(() => overlay.classList.add('show'), 150);
  try {
    return await work();
  } finally {
    window.clearTimeout(timer);
    if (--busyDepth === 0) overlay.classList.remove('show');
  }
}

/* ------------------------------------------------------------------ modals */

export interface ModalHandle {
  root: HTMLElement;
  close: () => void;
}

/**
 * Opens an accessible modal dialog built on the native <dialog> element.
 * `body` is trusted, static markup produced by this app.
 */
export function openModal(title: string, body: string, options: { wide?: boolean; onClose?: () => void } = {}): ModalHandle {
  const dialog = document.createElement('dialog');
  dialog.className = `modal${options.wide ? ' modal-wide' : ''}`;
  dialog.innerHTML = `
    <form method="dialog" class="modal-card">
      <header class="modal-header">
        <h2>${escapeHtml(title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${icon('close')}</button>
      </header>
      <div class="modal-body">${body}</div>
    </form>`;
  hydrateIcons(dialog);
  document.body.append(dialog);

  const close = () => {
    if (dialog.open) dialog.close();
  };
  dialog.addEventListener('close', () => {
    options.onClose?.();
    dialog.remove();
  });
  dialog.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target === dialog || target.closest('[data-close]')) close();
  });
  dialog.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
  dialog.showModal();
  return { root: dialog, close };
}

/* --------------------------------------------------------------- downloads */

export function downloadBlob(data: Uint8Array | Blob, filename: string, type = 'application/pdf'): void {
  const blob = data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Opens the native file picker and resolves with the chosen files. */
export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}
