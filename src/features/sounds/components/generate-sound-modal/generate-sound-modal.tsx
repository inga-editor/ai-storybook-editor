import { Loader2, Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/utils';
import { supabase } from '@/apis/supabase';
import { callGenerateSoundEffect } from '@/apis/sound-api';
import {
  mapAudioRow,
  normalizeTags,
  useGenerateModalFlow,
  type AudioResource,
  type AudioRow,
  type GenerateOutcome,
} from '@/features/audio-library';
import { createLogger } from '@/utils/logger';
import { GenerateSoundForm } from './generate-sound-form';
import { GenerateSoundAudition } from './generate-sound-audition';
import { validateGenerateSoundForm } from './generate-sound-form-validation';
import { mapGenerateSoundErrorMessage } from './generate-sound-error-mapping';
import {
  DEFAULT_GENERATE_SOUND_FORM,
  type GenerateSoundFormState,
  type SoundGenerationResult,
} from './generate-sound-modal-types';

const log = createLogger('Sounds', 'GenerateSoundModal');

export interface GenerateSoundModalProps {
  onClose: () => void;
  onSaved: (sound: AudioResource) => void;
}

export function GenerateSoundModal({ onClose, onSaved }: GenerateSoundModalProps) {
  const flow = useGenerateModalFlow<GenerateSoundFormState, SoundGenerationResult>({
    initialForm: DEFAULT_GENERATE_SOUND_FORM,
    validate: (form) => {
      const v = validateGenerateSoundForm(form);
      return { isValid: v.isValid, errors: v.errors as Record<string, string> };
    },
    generate: async (form, { seed }): Promise<GenerateOutcome<SoundGenerationResult>> => {
      log.info('generate', 'start', {
        descLen: form.description.trim().length,
        loop: form.loop,
        durationAuto: form.durationAuto,
        hasSeed: typeof seed === 'number',
      });
      const r = await callGenerateSoundEffect({
        description: form.description.trim(),
        loop: form.loop,
        durationSecs: form.durationAuto ? null : form.durationSecs,
        promptInfluence: form.promptInfluence,
        seed,
        // Opt-in auto-persist — absolute table target (Backend B insert). Client warns on soft-fail.
        saveResource: { type: 'sound_effect', path: 'table:sounds' },
      });
      if (r.success) {
        log.info('generate', 'success', {
          durationSecs: r.data.durationSecs,
          mediaType: r.data.mediaType,
        });
        return {
          success: true,
          data: {
            soundUrl: r.data.soundUrl,
            durationSecs: r.data.durationSecs,
            mediaType: r.data.mediaType,
          },
        };
      }
      log.error('generate', 'failure', {
        errorCode: r.errorCode,
        httpStatus: r.httpStatus,
      });
      return {
        success: false,
        error: {
          code: r.errorCode,
          message: mapGenerateSoundErrorMessage(r.errorCode, r.error),
        },
      };
    },
    save: async (form, result) => {
      const trimmedName = form.name.trim();
      if (!trimmedName) {
        throw new Error('Name is required');
      }
      const trimmedDesc = form.description.trim();
      const tagsNorm = normalizeTags(form.tags);

      const insertPayload = {
        name: trimmedName,
        description: trimmedDesc.length > 0 ? trimmedDesc : null,
        tags: tagsNorm.length > 0 ? tagsNorm : null,
        loop: form.loop,
        media_url: result.soundUrl,
        duration: Math.round(result.durationSecs * 1000),
        influence: form.promptInfluence,
        source: 1,
      };

      log.info('save', 'insert', { durationMs: insertPayload.duration });
      const { data, error } = await supabase
        .from('sounds')
        .insert(insertPayload)
        .select('*')
        .single();
      if (error || !data) {
        log.error('save', 'insert failed', {
          code: error?.code,
          message: error?.message,
        });
        throw new Error('Failed to save sound. Please try again.');
      }
      const sound = mapAudioRow(data as AudioRow);
      log.info('save', 'success', { id: sound.id });
      return sound;
    },
    onSaved: (sound) => {
      onSaved(sound);
      onClose();
    },
  });

  const isFormValid = validateGenerateSoundForm(flow.form).isValid;
  const generateLabel = flow.step === 'generating' ? 'Generating...' : 'Generate';
  const saveLabel = flow.step === 'saving' ? 'Saving...' : 'Save';
  const canSave = flow.hasResult && flow.form.name.trim().length > 0 && !flow.isWorking;

  return (
    <Dialog open onOpenChange={(open) => flow.handleDismiss(open, onClose)}>
      <DialogContent
        className={cn(
          'sm:max-w-[480px] max-h-[85vh] flex flex-col p-0 gap-0',
          flow.isWorking && '[&>button[aria-label=Close]]:hidden',
        )}
      >
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Generate
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-5">
          <GenerateSoundForm
            value={flow.form}
            onChange={flow.setForm}
            disabled={flow.isWorking}
            showValidation={flow.showValidation}
          />

          {flow.result ? (
            <GenerateSoundAudition result={flow.result} disabled={flow.isWorking} />
          ) : null}

          {flow.error ? (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
            >
              {flow.error.message}
            </div>
          ) : null}
        </div>

        <DialogFooter className="border-t px-6 py-4 flex-row justify-end gap-2">
          <Button
            type="button"
            variant="default"
            onClick={flow.handleGenerate}
            disabled={!isFormValid || flow.isWorking}
            className="gap-2"
          >
            {flow.step === 'generating' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {generateLabel}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={flow.handleSave}
            disabled={!canSave}
            className="gap-2"
          >
            {flow.step === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
