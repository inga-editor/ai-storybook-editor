// clone-book-confirm-dialog.test.tsx — Confirm step for "Clone this book" (phase 04).
//
// Locks the three properties the spec (§3.6.3) actually promises: the dialog names the book, an
// in-flight clone cannot be dismissed or re-submitted, and a failure is announced inline while the
// dialog stays open for a retry.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloneBookConfirmDialog } from './clone-book-confirm-dialog';

interface RenderOptions {
  bookTitle?: string;
  isCloning?: boolean;
  error?: string | null;
}

function renderDialog(options: RenderOptions = {}) {
  const spies = { onOpenChange: vi.fn(), onConfirm: vi.fn() };

  render(
    <CloneBookConfirmDialog
      isOpen
      bookTitle={options.bookTitle ?? 'My Book'}
      isCloning={options.isCloning ?? false}
      error={options.error ?? null}
      onOpenChange={spies.onOpenChange}
      onConfirm={spies.onConfirm}
    />,
  );

  return { user: userEvent.setup(), ...spies };
}

const confirmButton = () => screen.getByRole('button', { name: /clon/i });
const cancelButton = () => screen.getByRole('button', { name: /cancel/i });

describe('CloneBookConfirmDialog', () => {
  it('names the book being copied', () => {
    renderDialog({ bookTitle: 'The Lost Kite' });

    expect(screen.getByRole('alertdialog')).toHaveTextContent('The Lost Kite');
  });

  it('falls back to "Untitled" for a book with no title', () => {
    renderDialog({ bookTitle: '' });

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Untitled');
  });

  it('confirms without closing itself, so the in-flight state stays visible', async () => {
    const { user, onConfirm, onOpenChange } = renderDialog();

    await user.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Radix closes on Action click by default; the component prevents that on purpose.
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('disables both buttons while the clone is in flight', () => {
    renderDialog({ isCloning: true });

    expect(confirmButton()).toBeDisabled();
    expect(cancelButton()).toBeDisabled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Cloning');
  });

  it('ignores Escape while the clone is in flight', async () => {
    const { user, onOpenChange } = renderDialog({ isCloning: true });

    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('closes on Escape when idle', async () => {
    const { user, onOpenChange } = renderDialog({ isCloning: false });

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('announces a failure inline and stays open for a retry', () => {
    renderDialog({ error: 'Cloning is not available yet.' });

    expect(screen.getByRole('alert')).toHaveTextContent('Cloning is not available yet.');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
  });
});
