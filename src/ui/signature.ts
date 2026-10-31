import { openModal } from './dom';

export interface SignatureImage {
  /** PNG data URL, cropped to the ink. */
  image: string;
  /** width / height of the image. */
  aspect: number;
}

const COLORS = [
  { name: 'Black', value: '#111111' },
  { name: 'Blue', value: '#1b3fae' },
  { name: 'Dark red', value: '#8a1c1c' },
];

// Only locally installed fonts are used, so no font is ever downloaded from a third party.
const FONTS = [
  { style: 'normal', family: '"Snell Roundhand", "Segoe Script", "Brush Script MT", "Apple Chancery", cursive' },
  { style: 'normal', family: '"Bradley Hand", "Segoe Print", "Chalkboard", "Comic Sans MS", cursive' },
  { style: 'italic', family: '"Baskerville", "Georgia", "Times New Roman", serif' },
];
const fontCss = (index: number, size: number) => `${FONTS[index].style} ${size}px ${FONTS[index].family}`;

/** Signatures created in this browser tab. Kept in memory only and never persisted. */
const recent: SignatureImage[] = [];

/** Crops a canvas to its non-transparent pixels (plus padding). Returns null if empty. */
export function cropToInk(source: HTMLCanvasElement, padding = 6): HTMLCanvasElement | null {
  const ctx = source.getContext('2d', { willReadFrequently: true })!;
  const { width, height } = source;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(width - 1, maxX + padding);
  maxY = Math.min(height - 1, maxY + padding);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d')!.drawImage(source, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function toSignature(canvas: HTMLCanvasElement | null): SignatureImage | null {
  if (!canvas) return null;
  return { image: canvas.toDataURL('image/png'), aspect: canvas.width / canvas.height };
}

/** Opens the signature pad. Resolves with the created signature or null when cancelled. */
export function openSignaturePad(): Promise<SignatureImage | null> {
  return new Promise((resolve) => {
    let result: SignatureImage | null = null;
    const colorButtons = COLORS.map(
      (c, i) =>
        `<button type="button" class="swatch${i === 0 ? ' active' : ''}" data-color="${c.value}" style="--swatch:${c.value}" aria-label="${c.name} ink" title="${c.name}"></button>`,
    ).join('');
    const recentHtml = recent.length
      ? `<div class="recent-sigs"><span class="field-label">Recent</span><div class="recent-list">${recent
          .map((r, i) => `<button type="button" class="recent-sig" data-recent="${i}" aria-label="Use recent signature ${i + 1}"><img alt="" src="${r.image}"></button>`)
          .join('')}</div></div>`
      : '';

    const modal = openModal(
      'Add signature',
      `
      ${recentHtml}
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="tab active" data-tab="draw" aria-selected="true">Draw</button>
        <button type="button" role="tab" class="tab" data-tab="type" aria-selected="false">Type</button>
        <button type="button" role="tab" class="tab" data-tab="image" aria-selected="false">Image</button>
      </div>

      <div class="tab-panel" data-panel="draw">
        <div class="sig-pad">
          <canvas class="sig-canvas" aria-label="Signature drawing area"></canvas>
          <div class="sig-baseline"></div>
          <span class="sig-placeholder">Sign here with your mouse, trackpad or finger</span>
        </div>
      </div>

      <div class="tab-panel" data-panel="type" hidden>
        <input class="text-input sig-text" type="text" maxlength="60" placeholder="Type your name" autocomplete="name" />
        <div class="font-list">
          ${FONTS.map(
            (_, i) =>
              `<label class="font-option"><input type="radio" name="sig-font" value="${i}" ${i === 0 ? 'checked' : ''}><span style='font:${fontCss(i, 28)}' data-font-preview>Your name</span></label>`,
          ).join('')}
        </div>
      </div>

      <div class="tab-panel" data-panel="image" hidden>
        <label class="file-drop">
          <input type="file" accept="image/*" class="sig-file" hidden />
          <span class="file-drop-label">Choose an image of your signature</span>
          <canvas class="sig-image-preview" hidden></canvas>
        </label>
        <label class="checkbox"><input type="checkbox" class="sig-transparent" checked /> Remove white background</label>
      </div>

      <div class="sig-options">
        <div class="swatches" role="radiogroup" aria-label="Ink colour">${colorButtons}</div>
        <button type="button" class="link-btn sig-clear">Clear</button>
      </div>

      <p class="note">Your signature is only kept in this tab's memory and is never uploaded.</p>
      <footer class="modal-footer">
        <button type="button" class="secondary-btn" data-close>Cancel</button>
        <button type="button" class="primary-btn sig-add" disabled>Add signature</button>
      </footer>`,
      { onClose: () => resolve(result) },
    );
    const root = modal.root;
    const addBtn = root.querySelector<HTMLButtonElement>('.sig-add')!;
    let tab = 'draw';
    let color = COLORS[0].value;

    /* ---------------------------------------------------------- tabs */
    root.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) =>
      btn.addEventListener('click', () => {
        tab = btn.dataset.tab!;
        root.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', String(b === btn));
        });
        root.querySelectorAll<HTMLElement>('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== tab));
        if (tab === 'type') root.querySelector<HTMLInputElement>('.sig-text')!.focus();
        refresh();
      }),
    );

    /* -------------------------------------------------------- colours */
    root.querySelectorAll<HTMLButtonElement>('.swatch').forEach((btn) =>
      btn.addEventListener('click', () => {
        color = btn.dataset.color!;
        root.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', b === btn));
        recolorPad();
        updateTypePreview();
      }),
    );

    /* ----------------------------------------------------------- draw */
    const pad = root.querySelector<HTMLCanvasElement>('.sig-canvas')!;
    const padCtx = pad.getContext('2d', { willReadFrequently: true })!;
    const dpr = Math.max(2, window.devicePixelRatio || 1);
    const rect = pad.getBoundingClientRect();
    pad.width = Math.round((rect.width || 520) * dpr);
    pad.height = Math.round((rect.height || 200) * dpr);
    padCtx.scale(dpr, dpr);
    padCtx.lineCap = 'round';
    padCtx.lineJoin = 'round';
    let hasInk = false;
    let last: { x: number; y: number; w: number } | null = null;

    const point = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      const pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
      return { x: e.clientX - r.left, y: e.clientY - r.top, w: 1.2 + pressure * 3 };
    };
    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      last = point(e);
      padCtx.fillStyle = color;
      padCtx.beginPath();
      padCtx.arc(last.x, last.y, last.w / 2, 0, Math.PI * 2);
      padCtx.fill();
      hasInk = true;
      refresh();
    });
    pad.addEventListener('pointermove', (e) => {
      if (!last) return;
      const events = e.getCoalescedEvents?.() ?? [e];
      for (const ev of events) {
        const p = point(ev);
        const mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
        padCtx.strokeStyle = color;
        padCtx.lineWidth = (last.w + p.w) / 2;
        padCtx.beginPath();
        padCtx.moveTo(last.x, last.y);
        padCtx.quadraticCurveTo(mid.x, mid.y, p.x, p.y);
        padCtx.stroke();
        last = p;
      }
    });
    const end = () => (last = null);
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);

    function recolorPad() {
      if (!hasInk) return;
      padCtx.save();
      padCtx.globalCompositeOperation = 'source-in';
      padCtx.fillStyle = color;
      padCtx.fillRect(0, 0, pad.width, pad.height);
      padCtx.restore();
    }

    /* ----------------------------------------------------------- type */
    const textInput = root.querySelector<HTMLInputElement>('.sig-text')!;
    const fontIndex = () => Number(root.querySelector<HTMLInputElement>('input[name="sig-font"]:checked')?.value ?? 0);
    function updateTypePreview() {
      root.querySelectorAll<HTMLElement>('[data-font-preview]').forEach((el) => {
        el.textContent = textInput.value.trim() || 'Your name';
        el.style.color = color;
      });
    }
    textInput.addEventListener('input', () => {
      updateTypePreview();
      refresh();
    });
    root.querySelectorAll('input[name="sig-font"]').forEach((r) => r.addEventListener('change', refresh));
    updateTypePreview();

    function renderTyped(): HTMLCanvasElement | null {
      const text = textInput.value.trim();
      if (!text) return null;
      const css = fontCss(fontIndex(), 120);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.font = css;
      const width = Math.ceil(ctx.measureText(text).width) + 80;
      canvas.width = Math.min(4000, width);
      canvas.height = 220;
      ctx.font = css;
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 40, 110);
      return cropToInk(canvas, 8);
    }

    /* ---------------------------------------------------------- image */
    const fileInput = root.querySelector<HTMLInputElement>('.sig-file')!;
    const preview = root.querySelector<HTMLCanvasElement>('.sig-image-preview')!;
    const transparent = root.querySelector<HTMLInputElement>('.sig-transparent')!;
    let bitmap: ImageBitmap | null = null;

    async function renderImage() {
      if (!bitmap) return;
      const scale = Math.min(1, 1600 / bitmap.width, 800 / bitmap.height);
      preview.width = Math.max(1, Math.round(bitmap.width * scale));
      preview.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = preview.getContext('2d', { willReadFrequently: true })!;
      ctx.clearRect(0, 0, preview.width, preview.height);
      ctx.drawImage(bitmap, 0, 0, preview.width, preview.height);
      if (transparent.checked) {
        const img = ctx.getImageData(0, 0, preview.width, preview.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (lum > 215) d[i + 3] = 0;
          else if (lum > 170) d[i + 3] = Math.min(d[i + 3], Math.round(((215 - lum) / 45) * 255));
        }
        ctx.putImageData(img, 0, 0);
      }
      preview.hidden = false;
      root.querySelector<HTMLElement>('.file-drop-label')!.textContent = 'Choose a different image';
      refresh();
    }
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        bitmap?.close();
        bitmap = await createImageBitmap(file);
        await renderImage();
      } catch {
        root.querySelector<HTMLElement>('.file-drop-label')!.textContent = `Couldn't read “${file.name}”. Try a PNG or JPEG.`;
      }
    });
    transparent.addEventListener('change', renderImage);

    /* ---------------------------------------------------------- clear */
    root.querySelector('.sig-clear')!.addEventListener('click', () => {
      if (tab === 'draw') {
        padCtx.clearRect(0, 0, pad.width, pad.height);
        hasInk = false;
      } else if (tab === 'type') {
        textInput.value = '';
        updateTypePreview();
      } else {
        bitmap?.close();
        bitmap = null;
        fileInput.value = '';
        preview.hidden = true;
        root.querySelector<HTMLElement>('.file-drop-label')!.textContent = 'Choose an image of your signature';
      }
      refresh();
    });

    function refresh() {
      const ready = tab === 'draw' ? hasInk : tab === 'type' ? textInput.value.trim().length > 0 : !!bitmap;
      addBtn.disabled = !ready;
      root.querySelector('.sig-pad')!.classList.toggle('has-ink', hasInk);
    }

    function finish(sig: SignatureImage | null) {
      if (!sig) return;
      result = sig;
      if (!recent.some((r) => r.image === sig.image)) {
        recent.unshift(sig);
        recent.length = Math.min(recent.length, 4);
      }
      bitmap?.close();
      modal.close();
    }

    addBtn.addEventListener('click', () => {
      if (tab === 'draw') finish(toSignature(cropToInk(pad, 6)));
      else if (tab === 'type') finish(toSignature(renderTyped()));
      else finish(toSignature(cropToInk(preview, 4)));
    });

    root.querySelectorAll<HTMLButtonElement>('[data-recent]').forEach((btn) =>
      btn.addEventListener('click', () => finish(recent[Number(btn.dataset.recent)])),
    );
  });
}
