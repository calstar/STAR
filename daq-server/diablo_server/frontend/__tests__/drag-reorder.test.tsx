/**
 * useDragReorder: where the insertion line is drawn while dragging, and where the item lands.
 * jsdom has no layout, so each row is given a 20 px box and the pointer's clientY picks its half.
 */
import React, { useState } from 'react';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { moveItem, useDragReorder } from '@/lib/drag-reorder';

function List() {
  const [items, setItems] = useState(['A', 'B', 'C', 'D']);
  const d = useDragReorder((from, to) => setItems((xs) => moveItem(xs, from, to)));
  return (
    <div data-testid="list" {...d.listProps()}>
      {items.map((x, i) => (
        <div key={x} data-testid={`row:${x}`} {...d.rowProps(i)} className={d.rowClass(i, items.length)}>
          <span data-testid={`handle:${x}`} {...d.handleProps(i, items.length)}>⠿</span>{x}
        </div>
      ))}
    </div>
  );
}

const dt = () => ({ setData: () => {}, setDragImage: () => {}, effectAllowed: '', dropEffect: '' });
const box = (el: HTMLElement, top: number) => {
  el.getBoundingClientRect = () => ({ top, height: 20, bottom: top + 20, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) });
};
// jsdom has no DragEvent, so an init's clientY is dropped; set it on the event itself.
const over = (el: HTMLElement, data: object, clientY: number, kind: 'dragOver' | 'drop' = 'dragOver') => {
  const ev = createEvent[kind](el, { dataTransfer: data });
  Object.defineProperty(ev, 'clientY', { value: clientY });
  fireEvent(el, ev);
};
const order = () => screen.getAllByTestId(/^row:/).map((r) => r.textContent?.slice(1));
const lineOn = () => screen.getAllByTestId(/^row:/)
  .filter((r) => /before:bg-blue-500|shadow-\[inset/.test(r.className))
  .map((r) => `${r.textContent?.slice(1)}:${/-top-|inset_0_3px/.test(r.className) ? 'above' : 'below'}`);

afterEach(cleanup);

describe('useDragReorder', () => {
  it('draws the line in the gap under the pointer and drops the item there', () => {
    render(<List />);
    ['A', 'B', 'C', 'D'].forEach((x, i) => box(screen.getByTestId(`row:${x}`), i * 20));
    const data = dt();
    fireEvent.dragStart(screen.getByTestId('handle:A'), { dataTransfer: data });

    // Bottom half of C: insert below C, i.e. above D.
    over(screen.getByTestId('row:C'), data, 55);
    expect(lineOn()).toEqual(['D:above']);
    // Bottom half of D: below the last row.
    over(screen.getByTestId('row:D'), data, 75);
    expect(lineOn()).toEqual(['D:below']);

    over(screen.getByTestId('row:D'), data, 75, 'drop');
    expect(order()).toEqual(['B', 'C', 'D', 'A']);
    expect(lineOn()).toEqual([]);
  });

  it('shows no line where dropping would leave the item in place', () => {
    render(<List />);
    ['A', 'B', 'C', 'D'].forEach((x, i) => box(screen.getByTestId(`row:${x}`), i * 20));
    const data = dt();
    fireEvent.dragStart(screen.getByTestId('handle:B'), { dataTransfer: data });
    over(screen.getByTestId('row:A'), data, 15);  // below A = above B
    expect(lineOn()).toEqual([]);
    over(screen.getByTestId('row:A'), data, 5);   // above A
    expect(lineOn()).toEqual(['A:above']);
  });

  it('a drop in the space between rows lands where the line was', () => {
    render(<List />);
    ['A', 'B', 'C', 'D'].forEach((x, i) => box(screen.getByTestId(`row:${x}`), i * 20));
    const data = dt();
    fireEvent.dragStart(screen.getByTestId('handle:D'), { dataTransfer: data });
    over(screen.getByTestId('row:B'), data, 25);  // above B
    fireEvent.drop(screen.getByTestId('list'), { dataTransfer: data });
    expect(order()).toEqual(['A', 'D', 'B', 'C']);
  });
});
