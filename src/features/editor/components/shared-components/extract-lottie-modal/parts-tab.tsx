// parts-tab.tsx — Right-sidebar params for the Parts tab (design 01-parts-tab.md §1). Kind switch
// (Normal / Null) in the header; Normal shows Segment Model (SAM3-only, 1 option) + Prompt + Create;
// Null hides both and Create spawns a rig node immediately. Presentational — the shell owns state +
// the async segment/create action.

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/utils/utils';
import type { LottiePartKind } from './extract-lottie-modal-types';
import {
  SEGMENT_MODEL_OPTIONS,
  SEGMENT_PROMPT_MAX,
  SWAP_MODAL_TOKENS,
  Z_INDEX,
} from './extract-lottie-modal-constants';

const SELECT_CONTENT_STYLE = { ...SWAP_MODAL_TOKENS, zIndex: Z_INDEX.selectDropdown };
const SECTION_LABEL_CLASS =
  'mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';

export interface PartsTabProps {
  createKind: LottiePartKind;
  onCreateKindChange: (kind: LottiePartKind) => void;
  segmentModel: string;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onCreate: () => void;
  isProcessing: boolean;
}

export function PartsTab({
  createKind,
  onCreateKindChange,
  segmentModel,
  prompt,
  onPromptChange,
  onCreate,
  isProcessing,
}: PartsTabProps) {
  const isNormal = createKind === 'normal';
  const createDisabled = isProcessing || (isNormal && prompt.trim().length === 0);

  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      {/* Kind switch */}
      <section>
        <p className={SECTION_LABEL_CLASS}>Kind</p>
        <div className="flex rounded-lg bg-[var(--swap-modal-surface-hover)] p-1">
          {(['normal', 'null'] as LottiePartKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={isProcessing}
              onClick={() => onCreateKindChange(kind)}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-sm capitalize transition-colors disabled:cursor-not-allowed',
                createKind === kind
                  ? 'bg-white font-semibold text-[#0a0d18] shadow-sm'
                  : 'text-[var(--swap-modal-text-muted)] hover:text-[var(--swap-modal-text-primary)]',
              )}
            >
              {kind === 'normal' ? 'Normal' : 'Null'}
            </button>
          ))}
        </div>
      </section>

      {isNormal && (
        <>
          <section>
            <p className={SECTION_LABEL_CLASS}>Segment Model</p>
            <Select value={segmentModel} onValueChange={() => undefined} disabled>
              <SelectTrigger
                className="w-full border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-primary)]"
                aria-label="Segment model"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={SELECT_CONTENT_STYLE}>
                {SEGMENT_MODEL_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          <section>
            <p className={SECTION_LABEL_CLASS}>Prompt</p>
            <Textarea
              value={prompt}
              onChange={(e) => onPromptChange(e.target.value)}
              maxLength={SEGMENT_PROMPT_MAX}
              rows={3}
              placeholder="e.g. head, left arm, tail…"
              aria-label="Segment prompt"
              className="resize-none border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-primary)] placeholder:text-[var(--swap-modal-text-muted)] focus-visible:ring-[var(--swap-modal-accent)]"
            />
            <p className="mt-1 text-right text-[11px] tabular-nums text-[var(--swap-modal-text-muted)]">
              {prompt.length}/{SEGMENT_PROMPT_MAX}
            </p>
          </section>
        </>
      )}

      <button
        type="button"
        disabled={createDisabled}
        onClick={onCreate}
        className="w-full rounded-md bg-[var(--swap-modal-accent)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--swap-modal-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isProcessing ? 'Đang xử lý…' : '+ Create'}
      </button>
    </div>
  );
}
