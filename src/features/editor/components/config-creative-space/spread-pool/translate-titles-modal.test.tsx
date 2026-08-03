// translate-titles-modal.test.tsx — behaviour lock for the [Translate] client job.
//
// Guards the phase-06 completion criteria:
//  1. Empty eligible (no original-language titles) → toast, NO API call.
//  2. 2 languages, 1 fails → the OK language's column is overwritten in draft, the failed
//     language's column is left unchanged, and a "{ok}/{total}" summary toast fires.
//  3. Close/unmount mid-run aborts silently (no summary toast, no post-unmount setState).
//
// callTranslateContent + sonner are mocked (no network). vitest only — NO node builtins.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { SpreadPoolRowData } from './spread-pool-row';
import type { Language } from '@/types/editor';
import type { TranslateContentParams, TranslateContentResult } from '@/apis/text-api';

// ── Mocks ────────────────────────────────────────────────────────────────────
// vi.mock factories are hoisted above the module body, so the fns they close over must
// come from vi.hoisted (evaluated first) — plain top-level consts are still in the TDZ.
const { callTranslateContentMock, toastInfo, toastSuccess, toastError } = vi.hoisted(() => ({
  callTranslateContentMock: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/apis/text-api', () => ({
  callTranslateContent: (p: TranslateContentParams, o?: unknown) => callTranslateContentMock(p, o),
}));

vi.mock('sonner', () => ({
  toast: { info: toastInfo, success: toastSuccess, error: toastError },
}));

import { TranslateTitlesModal } from './translate-titles-modal';

// ── Fixtures ─────────────────────────────────────────────────────────────────
function row(id: string, index: number, original?: string): SpreadPoolRowData {
  return {
    spreadId: id,
    index,
    pool: null,
    title: original ? { en_US: { text: original } } : null,
    thumbnailUrl: null,
  };
}

const LANGS: Language[] = [
  { name: 'Tiếng Việt', code: 'vi_VN' }, // getLanguageName('vi_VN') === 'Tiếng Việt'
  { name: '日本語', code: 'ja_JP' }, //      getLanguageName('ja_JP') === '日本語'
];

const onSave = vi.fn();
const onClose = vi.fn();

function renderModal(spreads: SpreadPoolRowData[], languages: Language[] = LANGS) {
  return render(
    <TranslateTitlesModal
      spreads={spreads}
      originalLanguage="en_US"
      languages={languages}
      snapshotId="snap-1"
      onSave={onSave}
      onClose={onClose}
    />,
  );
}

beforeEach(() => {
  cleanup();
  callTranslateContentMock.mockReset();
  toastInfo.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  onSave.mockReset();
  onClose.mockReset();
});

describe('TranslateTitlesModal — [Translate] client job', () => {
  it('empty eligible → toast + no API call', () => {
    renderModal([row('sp1', 1), row('sp2', 2)]); // no original titles
    fireEvent.click(screen.getByRole('button', { name: /^Translate/ }));
    expect(callTranslateContentMock).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith('No source titles to translate');
  });

  it('2 languages, 1 fails → OK column overwritten, failed column untouched, summary toast', async () => {
    callTranslateContentMock.mockImplementation(
      async (p: TranslateContentParams): Promise<TranslateContentResult> => {
        if (p.targetLanguage === 'Tiếng Việt') {
          return { success: true, data: { translations: p.content.map((c) => `${c}-vi`) } };
        }
        return { success: false, error: 'boom', httpStatus: 500, errorCode: 'LLM_ERROR' };
      },
    );

    renderModal([row('sp1', 1, 'Hello'), row('sp2', 2, 'World')]);
    fireEvent.click(screen.getByRole('button', { name: /^Translate/ }));

    // Two sequential calls — one per language.
    await waitFor(() => expect(callTranslateContentMock).toHaveBeenCalledTimes(2));

    // Active tab is the first language (vi) → its column is overwritten with translations.
    expect(await screen.findByDisplayValue('Hello-vi')).toBeInTheDocument();
    expect(screen.getByDisplayValue('World-vi')).toBeInTheDocument();

    // Summary toast reflects 1/2 (ja failed).
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Translated 1/2 languages'));
    expect(toastSuccess).not.toHaveBeenCalled();

    // Switch to the failed language (ja) → column stayed empty (draft unchanged).
    fireEvent.click(screen.getByRole('button', { name: '日本語' }));
    const jaInputs = screen.getAllByLabelText(/into ja_JP$/) as HTMLInputElement[];
    expect(jaInputs.every((i) => i.value === '')).toBe(true);
  });

  it('unmount mid-run aborts silently — no summary toast, no post-unmount setState', async () => {
    let resolveCall: (r: TranslateContentResult) => void = () => {};
    callTranslateContentMock.mockImplementation(
      () => new Promise<TranslateContentResult>((res) => { resolveCall = res; }),
    );

    const { unmount } = renderModal([row('sp1', 1, 'Hello')]);
    fireEvent.click(screen.getByRole('button', { name: /^Translate/ }));
    await waitFor(() => expect(callTranslateContentMock).toHaveBeenCalledTimes(1));

    // Close the modal mid-flight → cleanup aborts the controller.
    unmount();
    // Late resolution must be swallowed (signal.aborted) — no toast, no throw.
    resolveCall({ success: true, data: { translations: ['Hello-vi'] } });
    await Promise.resolve();

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('Save flips to "Saving…" (disabled) while the awaited onSave is pending', async () => {
    let resolveSave: () => void = () => {};
    onSave.mockImplementation(() => new Promise<void>((res) => { resolveSave = res; }));

    renderModal([row('sp1', 1, 'Hello')]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const savingBtn = await screen.findByRole('button', { name: /Saving…/ });
    expect(savingBtn).toBeDisabled();
    expect(onSave).toHaveBeenCalledTimes(1);

    resolveSave();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled(),
    );
  });
});
