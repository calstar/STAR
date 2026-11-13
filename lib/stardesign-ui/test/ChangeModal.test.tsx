/**
 * Enter in the new-document and rename boxes is spent in the box. A caller may
 * close the dialog inside onCreate (Hotbench's stand picker does, to ask first
 * on a stand past Idle); focus then returns to the button that opened it, and
 * Chrome delivers the same Enter's keypress there -- which opened the picker
 * again over the stand just made.
 */
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { ChangeModal } from '../src/ChangeModal';

const noop = async () => {};

function picker(onCreate = vi.fn(async () => {})) {
  render(
    <ChangeModal
      open
      onClose={() => {}}
      api={{ browse: async () => [], list: async () => [], listUsers: async () => [] } as never}
      noun="stand"
      documents={[]}
      activeKey={null}
      onSelect={() => {}}
      onCreate={onCreate}
      onRename={noop}
      onShare={noop}
      onLeave={noop}
      onCopy={noop}
    />,
  );
  return onCreate;
}

describe('ChangeModal, Enter in a name box', () => {
  it('creates and spends the Enter', () => {
    const onCreate = picker();
    fireEvent.click(screen.getByRole('button', { name: /new stand/i }));
    const box = screen.getByPlaceholderText('Stand name');
    fireEvent.change(box, { target: { value: 'LE4 (3)' } });
    const enter = createEvent.keyDown(box, { key: 'Enter' });
    fireEvent(box, enter);
    expect(onCreate).toHaveBeenCalledWith('LE4 (3)');
    expect(enter.defaultPrevented).toBe(true);
  });
});
