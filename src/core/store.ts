import type { DocState } from './types';

type Listener = (state: DocState) => void;

const EMPTY: DocState = { pages: [], signatures: [] };

/**
 * Immutable document store with undo/redo history. Every committed change pushes the
 * previous state on the undo stack, so operations such as delete, insert, reorder and
 * rotate are instant (no PDF work happens until export).
 */
export class DocStore {
  private current: DocState = EMPTY;
  private past: DocState[] = [];
  private future: DocState[] = [];
  private listeners = new Set<Listener>();
  private savedState: DocState = EMPTY;

  private readonly historyLimit: number;

  constructor(historyLimit = 100) {
    this.historyLimit = historyLimit;
  }

  get state(): DocState {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** True when the document changed since it was opened or last downloaded. */
  get isDirty(): boolean {
    return this.current !== this.savedState;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Applies a change and records it in the undo history. */
  update(change: (state: DocState) => DocState): void {
    const next = change(this.current);
    if (next === this.current) return;
    this.past.push(this.current);
    if (this.past.length > this.historyLimit) this.past.shift();
    this.future = [];
    this.set(next);
  }

  /** Replaces the whole document and clears the history (e.g. when opening a file). */
  reset(state: DocState = EMPTY): void {
    this.past = [];
    this.future = [];
    this.savedState = state;
    this.set(state);
  }

  markSaved(): void {
    this.savedState = this.current;
    this.emit();
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.current);
    this.set(prev);
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.current);
    this.set(next);
  }

  private set(state: DocState): void {
    this.current = state;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}

/** Removes pages (and their signatures) by id. */
export function removePages(state: DocState, ids: Iterable<string>): DocState {
  const remove = new Set(ids);
  if (remove.size === 0) return state;
  return {
    pages: state.pages.filter((p) => !remove.has(p.id)),
    signatures: state.signatures.filter((s) => !remove.has(s.pageId)),
  };
}

/** Inserts pages before position `at` (0 = beginning, pages.length = end). */
export function insertPages(state: DocState, at: number, pages: DocState['pages']): DocState {
  if (pages.length === 0) return state;
  const index = Math.max(0, Math.min(at, state.pages.length));
  return {
    ...state,
    pages: [...state.pages.slice(0, index), ...pages, ...state.pages.slice(index)],
  };
}

/**
 * Moves the pages with the given ids so that they end up before the page that is
 * currently at position `before` (pages.length = end), keeping their relative order.
 */
export function movePages(state: DocState, ids: Iterable<string>, before: number): DocState {
  const move = new Set(ids);
  if (move.size === 0) return state;
  const moving = state.pages.filter((p) => move.has(p.id));
  const shift = state.pages.slice(0, before).filter((p) => move.has(p.id)).length;
  const rest = state.pages.filter((p) => !move.has(p.id));
  const index = Math.max(0, Math.min(before - shift, rest.length));
  const pages = [...rest.slice(0, index), ...moving, ...rest.slice(index)];
  if (pages.every((p, i) => p === state.pages[i])) return state;
  return { ...state, pages };
}

/** Rotates the pages with the given ids by `delta` degrees clockwise. */
export function rotatePages(state: DocState, ids: Iterable<string>, delta: 90 | -90 | 180): DocState {
  const rotate = new Set(ids);
  if (rotate.size === 0) return state;
  return {
    ...state,
    pages: state.pages.map((p) =>
      rotate.has(p.id)
        ? { ...p, rotation: ((((p.rotation + delta) % 360) + 360) % 360) as DocState['pages'][number]['rotation'] }
        : p,
    ),
  };
}
