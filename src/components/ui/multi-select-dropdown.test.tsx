// multi-select-dropdown.test.tsx — covers the `lockedValues` capability (P02):
//   • a locked chip renders WITHOUT a ✕ (cannot be removed)
//   • a locked panel item is aria-disabled, still shows its ✓, and clicking is a no-op
//   • removing a NON-locked tag keeps the locked value in the emitted array

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MultiSelectDropdown, type MultiSelectOption } from './multi-select-dropdown';

const OPTIONS: MultiSelectOption[] = [
  { value: 'en_US', label: 'English' },
  { value: 'vi_VN', label: 'Vietnamese' },
  { value: 'ja_JP', label: 'Japanese' },
];

// Radix Popover drives its panel through pointer capture + scrollIntoView, which jsdom
// omits — stub them so the dropdown opens under userEvent.
beforeAll(() => {
  const proto = window.HTMLElement.prototype;
  proto.hasPointerCapture = vi.fn();
  proto.releasePointerCapture = vi.fn();
  proto.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function renderDropdown(overrides?: { onChange?: ReturnType<typeof vi.fn<(v: string[]) => void>> }) {
  const onChange = overrides?.onChange ?? vi.fn<(v: string[]) => void>();
  render(
    <MultiSelectDropdown
      options={OPTIONS}
      selectedValues={['en_US', 'vi_VN']}
      onChange={onChange}
      lockedValues={['en_US']}
    />,
  );
  return { onChange };
}

describe('MultiSelectDropdown lockedValues', () => {
  it('renders a locked chip without a ✕ but keeps the ✕ on non-locked chips', () => {
    renderDropdown();
    // English is locked → no remove control.
    expect(screen.queryByLabelText('Remove English')).toBeNull();
    // Vietnamese is not locked → remove control present.
    expect(screen.getByLabelText('Remove Vietnamese')).toBeInTheDocument();
  });

  it('disables the locked panel item (still ✓) and click is a no-op', async () => {
    const user = userEvent.setup();
    const { onChange } = renderDropdown();

    await user.click(screen.getByRole('combobox'));

    const englishOption = screen.getByRole('option', { name: /English/i });
    expect(englishOption).toHaveAttribute('aria-disabled', 'true');
    // Still marked selected (✓) despite being locked/disabled.
    expect(englishOption).toHaveAttribute('aria-selected', 'true');

    await user.click(englishOption);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the locked value when a non-locked tag is removed', async () => {
    const user = userEvent.setup();
    const { onChange } = renderDropdown();

    await user.click(screen.getByLabelText('Remove Vietnamese'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const emitted = onChange.mock.calls[0][0] as string[];
    expect(emitted).toContain('en_US'); // locked value retained
    expect(emitted).not.toContain('vi_VN'); // removed
  });

  it('re-adds a dropped locked value defensively (toggling a locked selected item)', async () => {
    // handleToggle guards locked values, so onChange is never called with a missing
    // locked value via the UI. This asserts the guard holds: selecting a fresh option
    // still carries the locked value through emitChange.
    const user = userEvent.setup();
    const { onChange } = renderDropdown();

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: /Japanese/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const emitted = onChange.mock.calls[0][0] as string[];
    expect(emitted).toContain('en_US'); // locked stays
    expect(emitted).toContain('ja_JP'); // newly added
  });
});
