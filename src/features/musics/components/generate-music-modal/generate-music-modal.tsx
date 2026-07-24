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
import { callGenerateMusic } from '@/apis/music-api';
import {
  mapAudioRow,
  normalizeTags,
  useGenerateModalFlow,
  type AudioResource,
  type AudioRow,
  type GenerateOutcome,
} from '@/features/audio-library';
import { createLogger } from '@/utils/logger';
import { GenerateMusicForm } from './generate-music-form';
import { GenerateMusicAudition } from './generate-music-audition';
import { ProgressHint } from './progress-hint';
import {
  validateGenerateMusicForm,
  validateGenerateMusicFormForSave,
} from './generate-music-form-validation';
import { mapGenerateMusicErrorMessage } from './generate-music-error-mapping';
import {
  INITIAL_GENERATE_MUSIC_FORM,
  type GenerateMusicFormState,
  type MusicGenerationResult,
} from './generate-music-modal-types';

const log = createLogger('Musics', 'GenerateMusicModal');

export interface GenerateMusicModalProps {
  onClose: () => void;
  onSaved: (music: AudioResource) => void;
}

export function GenerateMusicModal({ onClose, onSaved }: GenerateMusicModalProps) {
  const flow = useGenerateModalFlow<GenerateMusicFormState, MusicGenerationResult>({
    initialForm: INITIAL_GENERATE_MUSIC_FORM,
    validate: (form) => {
      const v = validateGenerateMusicForm(form);
      return { isValid: v.isValid, errors: v.errors as Record<string, string> };
    },
    generate: async (form, { seed }): Promise<GenerateOutcome<MusicGenerationResult>> => {
      log.info('generate', 'start', {
        descLen: form.description.trim().length,
        finetuneId: form.finetuneId,
        durationAuto: form.durationAuto,
        loop: form.loop,
        hasSeed: typeof seed === 'number',
      });
      const r = await callGenerateMusic({
        prompt: form.description.trim(),
        finetuneId: form.finetuneId,
        durationMs: form.durationAuto
          ? null
          : Math.round((form.durationSecs ?? 0) * 1000),
        loop: form.loop,
        name: form.name.trim() || 'Untitled',
        tags: normalizeTags(form.tags),
        forceInstrumental: true,
        seed,
        // Opt-in auto-persist — absolute table target (Backend B insert). Client warns on soft-fail.
        saveResource: { type: 'music_track', path: 'table:musics' },
      });
      if (r.success) {
        log.info('generate', 'success', {
          durationMs: r.data.durationMs,
          mediaType: r.data.mediaType,
        });
        return { success: true, data: r.data };
      }
      log.error('generate', 'failure', {
        errorCode: r.errorCode,
        httpStatus: r.httpStatus,
      });
      return {
        success: false,
        error: {
          code: r.errorCode,
          message: mapGenerateMusicErrorMessage(r.errorCode, r.error),
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
        media_url: result.musicUrl,
        duration: result.durationMs,
        influence: null,
        source: 1,
      };

      log.info('save', 'insert', { durationMs: insertPayload.duration });
      const { data, error } = await supabase
        .from('musics')
        .insert(insertPayload)
        .select('*')
        .single();
      if (error || !data) {
        log.error('save', 'insert failed', {
          code: error?.code,
          message: error?.message,
        });
        throw new Error('Failed to save music. Please try again.');
      }
      const music = mapAudioRow(data as AudioRow);
      log.info('save', 'success', { id: music.id });
      return music;
    },
    onSaved: (music) => {
      onSaved(music);
      onClose();
    },
  });

  const isFormValid = validateGenerateMusicForm(flow.form).isValid;
  const isSaveValid = validateGenerateMusicFormForSave(flow.form).isValid;
  const generateLabel = flow.step === 'generating' ? 'Generating...' : 'Generate';
  const saveLabel = flow.step === 'saving' ? 'Saving...' : 'Save';
  const canSave = flow.hasResult && isSaveValid && !flow.isWorking;

  // Hard-block dismiss while generating: parent flow.handleDismiss already
  // blocks `generating` and `saving` — we just preserve onEscape/onInteract.
  return (
    <Dialog open onOpenChange={(open) => flow.handleDismiss(open, onClose)}>
      <DialogContent
        className={cn(
          'sm:max-w-[480px] max-h-[85vh] flex flex-col p-0 gap-0',
          flow.isWorking && '[&>button[aria-label=Close]]:hidden',
        )}
        onEscapeKeyDown={(e) => {
          if (flow.isWorking) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (flow.isWorking) e.preventDefault();
        }}
      >
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Generate Music
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-5">
          <GenerateMusicForm
            value={flow.form}
            onChange={flow.setForm}
            disabled={flow.isWorking}
            showValidation={flow.showValidation}
          />

          {flow.step === 'generating' ? (
            <ProgressHint
              visibleAfterMs={30000}
              message="Music generation can take up to 90 seconds — please wait."
            />
          ) : null}

          {flow.result ? (
            <GenerateMusicAudition result={flow.result} disabled={flow.isWorking} />
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
