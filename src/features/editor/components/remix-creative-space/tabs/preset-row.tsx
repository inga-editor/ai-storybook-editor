// preset-row.tsx — One casting-axis card in the Story tab's Presets section.
// A label (axis name) above a Select of that axis's presets. The first item
// "Choose one" resets the choice to the axis DEFAULT preset (never stores null).
//
// The Select is a Radix dropdown portaled to <body>; inside the Radix Dialog it
// composes as a nested dismissable layer (clicking it never closes the modal —
// same behaviour as the modal's existing visual-profile Popover). SelectContent
// carries `Z_INDEX.selectDropdown` (4100) so it always paints above the dialog.

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { resolveDefaultPreset } from '@/features/editor/components/config-creative-space/casting-slot-helpers';
import { Z_INDEX } from '../swap-crop-sheet-modal/swap-modal-constants';
import type { CastingAxis } from '@/types/editor';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'RemixPresetRow');

/** Sentinel value for the "Choose one" reset item (Radix forbids empty-string
 *  item values; this is mapped back to the axis default on select). */
const CHOOSE_ONE = '__choose_one__';

const SELECT_CONTENT_STYLE = { zIndex: Z_INDEX.selectDropdown };

interface Props {
  axis: CastingAxis;
  selectedPresetId: string;
  onSelect: (presetId: string) => void;
}

export function PresetRow({ axis, selectedPresetId, onSelect }: Props) {
  const handleChange = (value: string) => {
    if (value === CHOOSE_ONE) {
      const def = resolveDefaultPreset(axis);
      log.debug('handleChange', 'reset to default preset', {
        axisId: axis.id,
        hasDefault: def !== null,
      });
      if (def) onSelect(def.id);
      return;
    }
    log.debug('handleChange', 'preset selected', { axisId: axis.id });
    onSelect(value);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border p-2">
      <span className="truncate text-xs font-medium text-muted-foreground">
        {axis.name}
      </span>
      <Select value={selectedPresetId} onValueChange={handleChange}>
        <SelectTrigger aria-label={`Preset for ${axis.name}`} className="w-full">
          <SelectValue placeholder="Choose one" />
        </SelectTrigger>
        <SelectContent style={SELECT_CONTENT_STYLE}>
          <SelectItem value={CHOOSE_ONE}>Choose one</SelectItem>
          {axis.presets.map((preset) => (
            <SelectItem key={preset.id} value={preset.id}>
              {preset.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
