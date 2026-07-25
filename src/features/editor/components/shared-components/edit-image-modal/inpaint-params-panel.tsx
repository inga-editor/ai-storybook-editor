// inpaint-params-panel.tsx — Right-sidebar controls of the Inpaint tab (design 04-inpaint-tab.md §1):
// Model select + Brush Size slider + Reference Images picker + Prompt textarea. NO History UI (mask
// undo/redo is hotkey-only per §5).
//
// Pure presentation — every value + handler comes from `useInpaintTabState`. Split out of
// inpaint-tab.tsx to keep that file under the 500-loc cap once the provenance wiring landed (P03).
// The reference-picker props are forwarded as ONE `picker` object so this file never has to change
// when the picker's own prop surface grows.

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { createLogger } from '@/utils/logger';
import {
  BRUSH,
  INPAINT_BRUSH_DEFAULT,
  INPAINT_MODEL_OPTIONS,
  INPAINT_PROMPT_MAX,
  SWAP_MODAL_OUTLINE_BUTTON_CLASS,
  Z_INDEX,
  type InpaintModel,
} from './edit-image-modal-constants';
import {
  InpaintReferencePicker,
  type InpaintReferencePickerProps,
} from './inpaint-reference-picker';

const log = createLogger('Editor', 'InpaintParamsPanel');

// Radix popper copies the content's computed z onto its portal wrapper — without this the
// dropdown (shadcn default z-50) paints behind the full-screen modal (z-4000). See memory.
const SELECT_CONTENT_STYLE = { zIndex: Z_INDEX.selectDropdown };
const DARK_TRIGGER_CLASS = `w-full ${SWAP_MODAL_OUTLINE_BUTTON_CLASS}`;
const SECTION_LABEL_CLASS =
  'mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--swap-modal-text-muted)]';

export interface InpaintParamsPanelProps {
  model: InpaintModel;
  onModelChange: (model: InpaintModel) => void;
  brushSize: number;
  onBrushSizeChange: (size: number) => void;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  /** Forwarded verbatim to InpaintReferencePicker (§8) — grouped so this file stays picker-agnostic. */
  picker: InpaintReferencePickerProps;
}

export function InpaintParamsPanel({
  model,
  onModelChange,
  brushSize,
  onBrushSizeChange,
  prompt,
  onPromptChange,
  picker,
}: InpaintParamsPanelProps) {
  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      <section>
        <p className={SECTION_LABEL_CLASS}>Model</p>
        <Select
          value={model}
          onValueChange={(v) => {
            log.debug('onValueChange', 'model changed', { model: v });
            onModelChange(v as InpaintModel);
          }}
        >
          <SelectTrigger className={DARK_TRIGGER_CLASS} aria-label="Inpaint model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent style={SELECT_CONTENT_STYLE}>
            {INPAINT_MODEL_OPTIONS.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <section>
        <p className={SECTION_LABEL_CLASS}>
          <span>Brush Size</span>
          <span className="normal-case tabular-nums text-[var(--swap-modal-text-secondary)]">
            {brushSize}px
          </span>
        </p>
        <Slider
          value={[brushSize]}
          min={BRUSH.min}
          max={BRUSH.max}
          step={BRUSH.step}
          onValueChange={(v) => onBrushSizeChange(v[0] ?? INPAINT_BRUSH_DEFAULT)}
          aria-label="Brush size"
        />
      </section>

      <InpaintReferencePicker {...picker} />

      <section>
        <p className={SECTION_LABEL_CLASS}>Prompt</p>
        <Textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          maxLength={INPAINT_PROMPT_MAX}
          rows={3}
          placeholder="Describe what to paint in the marked region…"
          aria-label="Inpaint prompt"
          className="resize-none border-[var(--swap-modal-border-strong)] bg-[var(--swap-modal-surface-hover)] text-[var(--swap-modal-text-primary)] placeholder:text-[var(--swap-modal-text-muted)] focus-visible:ring-[var(--swap-modal-accent)]"
        />
        <p className="mt-1 text-right text-[11px] tabular-nums text-[var(--swap-modal-text-muted)]">
          {prompt.length}/{INPAINT_PROMPT_MAX}
        </p>
      </section>
    </div>
  );
}
