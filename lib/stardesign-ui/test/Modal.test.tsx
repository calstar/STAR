/**
 * The dialog shell says aria-modal, so a screen reader confines itself to it; keyboard
 * focus has to go there too, or Tab walks the page behind an overlay the reader will not
 * announce. Every confirm in the three apps is built on this shell.
 */
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../src/Modal';

function Harness({ inputInside = false }: { inputInside?: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      <button>behind</button>
      <Modal
        open={open}
        // A fresh closure every render, as the apps pass it.
        onClose={() => setOpen(false)}
        title="Remove it?"
        footer={
          <>
            <button onClick={() => setOpen(false)}>Cancel</button>
            <button>Remove</button>
          </>
        }
      >
        {inputInside ? (
          <input aria-label="name" value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          'body'
        )}
      </Modal>
    </>
  );
}

describe('Modal focus', () => {
  it('moves focus into the dialog when it opens', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    const dlg = screen.getByRole('dialog');
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(dlg.contains(document.activeElement)).toBe(true);
    // Onto the dialog, not a destructive button: Enter on open must not remove anything.
    expect(document.activeElement).toBe(dlg);
  });

  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    const dlg = screen.getByRole('dialog');
    for (let i = 0; i < 5; i++) {
      await userEvent.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      await userEvent.tab({ shift: true });
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
  });

  it('gives focus back to the opener when it closes', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'open' });
    await userEvent.click(opener);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('leaves focus in a field inside it while the parent re-renders', async () => {
    render(<Harness inputInside />);
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    const field = screen.getByRole('textbox', { name: 'name' });
    await userEvent.click(field);
    await userEvent.type(field, 'abc');
    expect(field).toHaveValue('abc');
    expect(document.activeElement).toBe(field);
  });
});
