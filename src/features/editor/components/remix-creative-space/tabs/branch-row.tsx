// branch-row.tsx — One branch-spread row in the Story tab's Branches section.
// Layout: index (muted) · "SPREAD {n}" badge · branch question (truncate) ·
// branch Select on the right. "Choose one" resets to the spread's DEFAULT branch.
// Same Radix-Select-in-Dialog composition as PresetRow (see its header note).

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Z_INDEX } from '../swap-crop-sheet-modal/swap-modal-constants';
import type { BranchSpreadOption } from '@/types/remix';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'RemixBranchRow');

const CHOOSE_ONE = '__choose_one__';
const SELECT_CONTENT_STYLE = { zIndex: Z_INDEX.selectDropdown };

/** Default branch section for a spread — the `is_default` branch, else first. */
function defaultSectionId(option: BranchSpreadOption): string | null {
  return (
    option.branches.find((b) => b.is_default)?.section_id ??
    option.branches[0]?.section_id ??
    null
  );
}

interface Props {
  index: number; // 1-based
  option: BranchSpreadOption;
  selectedSectionId: string;
  onSelect: (sectionId: string) => void;
}

export function BranchRow({ index, option, selectedSectionId, onSelect }: Props) {
  const handleChange = (value: string) => {
    if (value === CHOOSE_ONE) {
      const def = defaultSectionId(option);
      log.debug('handleChange', 'reset to default branch', {
        spreadId: option.spread_id,
        hasDefault: def !== null,
      });
      if (def) onSelect(def);
      return;
    }
    log.debug('handleChange', 'branch selected', { spreadId: option.spread_id });
    onSelect(value);
  };

  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-4 shrink-0 text-right text-xs text-muted-foreground">
        {index}
      </span>
      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase text-muted-foreground">
        Spread {option.spread_number}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{option.title}</span>
      <Select value={selectedSectionId} onValueChange={handleChange}>
        <SelectTrigger
          aria-label={`Branch at spread ${option.spread_number}`}
          className="w-[260px] shrink-0"
        >
          <SelectValue placeholder="Choose one" />
        </SelectTrigger>
        <SelectContent style={SELECT_CONTENT_STYLE}>
          <SelectItem value={CHOOSE_ONE}>Choose one</SelectItem>
          {option.branches.map((branch) => (
            <SelectItem key={branch.section_id} value={branch.section_id}>
              {branch.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
