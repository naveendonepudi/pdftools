import { PageSizes } from 'pdf-lib';
import { chunkPages, formatPages, parseRanges } from '../core/ranges';
import { openModal } from './dom';
import { icon } from './icons';

/* ------------------------------------------------------------------ insert */

export interface InsertCallbacks {
  pageCount: number;
  /** One-based page number after which pages are inserted by default. */
  defaultAfter: number;
  /** Size (points, as displayed) of the page used for "same size" blank pages. */
  currentSize: { width: number; height: number };
  onFile: (at: number) => void;
  onBlank: (at: number, size: { width: number; height: number }) => void;
}

export function openInsertDialog(opts: InsertCallbacks): void {
  const modal = openModal(
    'Insert pages',
    `
    <div class="field">
      <label class="field-label" for="ins-where">Where</label>
      <div class="row">
        <select id="ins-where" class="select">
          <option value="start">At the beginning</option>
          <option value="after" selected>After page</option>
          <option value="end">At the end</option>
        </select>
        <input id="ins-page" class="text-input narrow" type="number" min="1" max="${opts.pageCount}" value="${opts.defaultAfter}" aria-label="Page number" />
        <span class="muted">of ${opts.pageCount}</span>
      </div>
    </div>

    <div class="choice-grid">
      <button type="button" class="choice" id="ins-file">
        ${icon('file', 28)}
        <strong>From a file</strong>
        <span>PDF or image (JPG, PNG…)</span>
      </button>
      <div class="choice">
        ${icon('blank', 28)}
        <strong>Blank page</strong>
        <select id="ins-size" class="select small" aria-label="Blank page size">
          <option value="same">Same as current page</option>
          <option value="a4">A4</option>
          <option value="letter">US Letter</option>
        </select>
        <button type="button" class="secondary-btn small" id="ins-blank">Insert blank page</button>
      </div>
    </div>
    <p class="note">Tip: you can also drag files straight into the thumbnail sidebar.</p>`,
  );
  const root = modal.root;
  const where = root.querySelector<HTMLSelectElement>('#ins-where')!;
  const pageInput = root.querySelector<HTMLInputElement>('#ins-page')!;
  where.addEventListener('change', () => (pageInput.disabled = where.value !== 'after'));

  const position = (): number => {
    if (where.value === 'start') return 0;
    if (where.value === 'end') return opts.pageCount;
    const n = Math.round(Number(pageInput.value));
    return Math.min(opts.pageCount, Math.max(0, Number.isFinite(n) ? n : opts.defaultAfter));
  };

  root.querySelector('#ins-file')!.addEventListener('click', () => {
    const at = position();
    modal.close();
    opts.onFile(at);
  });
  root.querySelector('#ins-blank')!.addEventListener('click', () => {
    const at = position();
    const choice = root.querySelector<HTMLSelectElement>('#ins-size')!.value;
    const [w, h] = choice === 'a4' ? PageSizes.A4 : choice === 'letter' ? PageSizes.Letter : [opts.currentSize.width, opts.currentSize.height];
    modal.close();
    opts.onBlank(at, { width: w, height: h });
  });
}

/* ------------------------------------------------------------------- split */

export interface SplitCallbacks {
  pageCount: number;
  /** Zero-based indices of the selected pages. */
  selected: number[];
  onSplit: (groups: number[][]) => void;
}

export function openSplitDialog(opts: SplitCallbacks): void {
  const half = Math.max(1, Math.ceil(opts.pageCount / 2));
  const modal = openModal(
    'Split PDF',
    `
    <div class="radio-list">
      <label class="radio-card">
        <input type="radio" name="split-mode" value="every" checked />
        <span class="radio-title">Every <input id="split-every" class="text-input tiny" type="number" min="1" max="${opts.pageCount}" value="1" aria-label="Pages per file" /> page(s)</span>
        <span class="radio-desc">One file per fixed number of pages</span>
      </label>
      <label class="radio-card">
        <input type="radio" name="split-mode" value="ranges" />
        <span class="radio-title">Custom ranges</span>
        <input id="split-ranges" class="text-input" type="text" placeholder="e.g. 1-${half}, ${Math.min(half + 1, opts.pageCount)}-${opts.pageCount}" value="1-${half}${half < opts.pageCount ? `, ${half + 1}-${opts.pageCount}` : ''}" aria-label="Page ranges" />
        <span class="radio-desc">Each comma separated range becomes its own PDF</span>
      </label>
      <label class="radio-card${opts.selected.length ? '' : ' disabled'}">
        <input type="radio" name="split-mode" value="selected" ${opts.selected.length ? '' : 'disabled'} />
        <span class="radio-title">Extract selected pages</span>
        <span class="radio-desc">${opts.selected.length ? `Pages ${formatPages(opts.selected)} into one PDF` : 'Select pages in the sidebar first'}</span>
      </label>
    </div>
    <p class="summary" id="split-summary" aria-live="polite"></p>
    <footer class="modal-footer">
      <button type="button" class="secondary-btn" data-close>Cancel</button>
      <button type="button" class="primary-btn" id="split-go">Split &amp; download</button>
    </footer>`,
  );
  const root = modal.root;
  const summary = root.querySelector<HTMLElement>('#split-summary')!;
  const go = root.querySelector<HTMLButtonElement>('#split-go')!;
  const everyInput = root.querySelector<HTMLInputElement>('#split-every')!;
  const rangesInput = root.querySelector<HTMLInputElement>('#split-ranges')!;

  const groups = (): number[][] => {
    const mode = root.querySelector<HTMLInputElement>('input[name="split-mode"]:checked')!.value;
    if (mode === 'every') return chunkPages(opts.pageCount, Number(everyInput.value));
    if (mode === 'ranges') return parseRanges(rangesInput.value, opts.pageCount);
    return [[...opts.selected].sort((a, b) => a - b)];
  };

  const update = () => {
    try {
      const g = groups();
      const labels = g.slice(0, 6).map((x) => formatPages(x));
      summary.textContent = `Creates ${g.length} PDF${g.length === 1 ? '' : 's'}: ${labels.join(' · ')}${g.length > 6 ? ' …' : ''}${g.length > 1 ? ' (downloaded as a .zip)' : ''}`;
      summary.classList.remove('error');
      go.disabled = false;
    } catch (err) {
      summary.textContent = (err as Error).message;
      summary.classList.add('error');
      go.disabled = true;
    }
  };

  const selectMode = (value: string) => {
    root.querySelector<HTMLInputElement>(`input[name="split-mode"][value="${value}"]`)!.checked = true;
    update();
  };
  everyInput.addEventListener('focus', () => selectMode('every'));
  rangesInput.addEventListener('focus', () => selectMode('ranges'));
  root.querySelectorAll('input').forEach((el) => el.addEventListener('input', update));
  root.querySelectorAll('input[name="split-mode"]').forEach((el) => el.addEventListener('change', update));
  update();

  go.addEventListener('click', () => {
    try {
      const g = groups();
      modal.close();
      opts.onSplit(g);
    } catch {
      update();
    }
  });
}

/* ----------------------------------------------------------------- privacy */

export function openPrivacyDialog(): void {
  openModal(
    'Your privacy',
    `
    <ul class="privacy-list">
      <li>${icon('shield', 22)}<div><strong>Your files never leave your device</strong><span>PDFs are opened, edited and saved entirely inside your browser. Nothing is uploaded to any server.</span></div></li>
      <li>${icon('eyeOff', 22)}<div><strong>We don't track or read your data</strong><span>No accounts, no cookies, no analytics, no ads and no third-party scripts. We can't see your documents or signatures.</span></div></li>
      <li>${icon('lock', 22)}<div><strong>Enforced by your browser</strong><span>A strict Content Security Policy blocks the page from sending data anywhere else.</span></div></li>
      <li>${icon('bolt', 22)}<div><strong>Gone when you close the tab</strong><span>Documents and signatures live only in memory and disappear when you close or reload the page.</span></div></li>
    </ul>
    <footer class="modal-footer">
      <button type="button" class="primary-btn" data-close>Got it</button>
    </footer>`,
  );
}
