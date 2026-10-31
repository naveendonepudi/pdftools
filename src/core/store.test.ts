import { describe, expect, it } from 'vitest';
import { DocStore, insertPages, movePages, removePages, rotatePages } from './store';
import type { DocState, PageRef } from './types';

function page(id: string): PageRef {
  return { id, sourceId: 's', index: 0, baseRotation: 0, rotation: 0, width: 100, height: 100 };
}

function ids(state: DocState): string[] {
  return state.pages.map((p) => p.id);
}

const base: DocState = {
  pages: ['a', 'b', 'c', 'd'].map(page),
  signatures: [{ id: 'sig', pageId: 'b', image: '', cx: 0, cy: 0, width: 1, height: 1, angle: 0 }],
};

describe('page operations', () => {
  it('removes pages and their signatures', () => {
    const next = removePages(base, ['b', 'c']);
    expect(ids(next)).toEqual(['a', 'd']);
    expect(next.signatures).toEqual([]);
  });

  it('inserts pages at a position', () => {
    expect(ids(insertPages(base, 0, [page('x')]))).toEqual(['x', 'a', 'b', 'c', 'd']);
    expect(ids(insertPages(base, 2, [page('x'), page('y')]))).toEqual(['a', 'b', 'x', 'y', 'c', 'd']);
    expect(ids(insertPages(base, 99, [page('x')]))).toEqual(['a', 'b', 'c', 'd', 'x']);
  });

  it('moves pages before a target position', () => {
    expect(ids(movePages(base, ['d'], 0))).toEqual(['d', 'a', 'b', 'c']);
    expect(ids(movePages(base, ['a'], 4))).toEqual(['b', 'c', 'd', 'a']);
    expect(ids(movePages(base, ['a', 'c'], 4))).toEqual(['b', 'd', 'a', 'c']);
    expect(ids(movePages(base, ['a', 'b'], 3))).toEqual(['c', 'a', 'b', 'd']);
    expect(movePages(base, ['b'], 1)).toBe(base);
  });

  it('rotates selected pages clockwise and counter-clockwise', () => {
    const cw = rotatePages(base, ['a'], 90);
    expect(cw.pages[0].rotation).toBe(90);
    expect(rotatePages(cw, ['a'], -90).pages[0].rotation).toBe(0);
    expect(rotatePages(base, ['a'], -90).pages[0].rotation).toBe(270);
  });
});

describe('DocStore', () => {
  it('supports undo and redo', () => {
    const store = new DocStore();
    store.reset(base);
    expect(store.isDirty).toBe(false);
    store.update((s) => removePages(s, ['a']));
    expect(ids(store.state)).toEqual(['b', 'c', 'd']);
    expect(store.isDirty).toBe(true);
    store.undo();
    expect(store.state).toBe(base);
    expect(store.isDirty).toBe(false);
    store.redo();
    expect(ids(store.state)).toEqual(['b', 'c', 'd']);
    expect(store.canRedo).toBe(false);
  });

  it('ignores no-op updates and notifies subscribers', () => {
    const store = new DocStore();
    store.reset(base);
    let calls = 0;
    store.subscribe(() => calls++);
    store.update((s) => s);
    expect(store.canUndo).toBe(false);
    store.update((s) => removePages(s, ['a']));
    expect(calls).toBe(1);
  });

  it('caps the history size', () => {
    const store = new DocStore(2);
    store.reset(base);
    store.update((s) => removePages(s, ['a']));
    store.update((s) => removePages(s, ['b']));
    store.update((s) => removePages(s, ['c']));
    store.undo();
    store.undo();
    expect(store.canUndo).toBe(false);
    expect(ids(store.state)).toEqual(['b', 'c', 'd']);
  });
});
