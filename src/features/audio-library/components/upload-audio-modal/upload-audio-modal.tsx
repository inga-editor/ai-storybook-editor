// Upload Audio modal — generic across sounds and musics.
// Caller passes `tableName`, `uploadPathPrefix`, `mimeWhitelist`, `maxSizeMb`,
// `influenceValue` to specialize for the resource. File size cap is enforced
// FE-side before delegating to the storage helper (which has its own caps).

import { useCallback, useState } from 'react';
import { Loader2, Upload as UploadIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/utils/utils';
import { supabase } from '@/apis/supabase';
import { uploadAudioToStorage } from '@/apis/storage-api';
import { STORAGE_BUCKET, isStorageServiceEnabled } from '@/constants/storage-constants';
import { deleteObjects } from '@/apis/storage-service-client';
import { useAuthStore } from '@/stores/auth-store';
import { createLogger } from '@/utils/logger';
import { mapAudioRow } from '../../utils/audio-mapper';
import { normalizeTags } from '../../utils/audio-filters';
import type { AudioResource, AudioRow, AudioTableName } from '../../types';
import { FileDropzone } from './file-dropzone';
import {
  DEFAULT_UPLOAD_FORM,
  NAME_MAX,
  type UploadAudioFormState,
  type UploadStep,
} from './upload-audio-modal-types';

const log = createLogger('AudioLibrary', 'UploadAudioModal');

export interface UploadAudioModalProps {
  tableName: AudioTableName;
  resourceTitle: string;
  /** Upload prefix; userId is appended automatically (`<prefix>/<userId>/...`). */
  uploadPathPrefix: string;
  maxSizeMb: number;
  mimeWhitelist: ReadonlyArray<string>;
  /** Stored on the row's `influence` column. Pass null for upload (no influence). */
  influenceValue: number | null;
  namePlaceholder?: string;
  descriptionPlaceholder?: string;
  tagsPlaceholder?: string;
  defaultLoop?: boolean;
  onClose: () => void;
  onSaved: (item: AudioResource) => void;
}

export function UploadAudioModal({
  tableName,
  resourceTitle,
  uploadPathPrefix,
  maxSizeMb,
  mimeWhitelist,
  influenceValue,
  namePlaceholder = 'e.g., Forest Ambience',
  descriptionPlaceholder = 'Briefly describe this audio...',
  tagsPlaceholder = 'e.g., ambient, nature, loop (comma separated)',
  defaultLoop = false,
  onClose,
  onSaved,
}: UploadAudioModalProps) {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [form, setForm] = useState<UploadAudioFormState>(() => ({
    ...DEFAULT_UPLOAD_FORM,
    loop: defaultLoop,
  }));
  const [step, setStep] = useState<UploadStep>('form');
  const [error, setError] = useState<string | null>(null);

  const trimmedName = form.name.trim();
  const maxFileBytes = maxSizeMb * 1024 * 1024;
  const acceptAttr = mimeWhitelist.join(', ');

  const isValid =
    trimmedName.length >= 1 &&
    trimmedName.length <= NAME_MAX &&
    form.file !== null &&
    form.fileError === null &&
    form.durationMs !== null;
  const isUploading = step === 'uploading';

  const handleFilePick = useCallback(
    (file: File) => {
      log.info('handleFilePick', 'validating file', {
        name: file.name,
        size: file.size,
        type: file.type,
      });

      if (!mimeWhitelist.includes(file.type)) {
        log.warn('handleFilePick', 'unsupported MIME', { type: file.type });
        setForm((prev) => ({
          ...prev,
          file: null,
          durationMs: null,
          fileError: `Unsupported file type. Allowed: ${mimeWhitelist.join(', ')}`,
        }));
        return;
      }

      if (file.size > maxFileBytes) {
        log.warn('handleFilePick', 'file too large', { size: file.size });
        setForm((prev) => ({
          ...prev,
          file: null,
          durationMs: null,
          fileError: `File too large. Max ${maxSizeMb}MB.`,
        }));
        return;
      }

      const url = URL.createObjectURL(file);
      const audio = new Audio();
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const durationMs = Math.round((audio.duration || 0) * 1000);
        URL.revokeObjectURL(url);
        log.info('handleFilePick', 'decoded duration', { durationMs });
        if (!Number.isFinite(audio.duration) || durationMs <= 0) {
          log.warn('handleFilePick', 'invalid duration', { durationMs });
          setForm((prev) => ({
            ...prev,
            file: null,
            durationMs: null,
            fileError: 'Unable to read audio duration.',
          }));
          return;
        }
        setForm((prev) => ({
          ...prev,
          file,
          durationMs,
          fileError: null,
        }));
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        log.error('handleFilePick', 'audio decode failed', { name: file.name });
        setForm((prev) => ({
          ...prev,
          file: null,
          durationMs: null,
          fileError: 'Unable to read audio file.',
        }));
      };
      audio.src = url;
    },
    [mimeWhitelist, maxFileBytes, maxSizeMb],
  );

  const handleRemoveFile = useCallback(() => {
    log.debug('handleRemoveFile', 'reset file');
    setForm((prev) => ({
      ...prev,
      file: null,
      durationMs: null,
      fileError: null,
    }));
  }, []);

  const handleUpload = useCallback(async () => {
    if (!isValid || !form.file || form.durationMs === null) {
      log.warn('handleUpload', 'invalid form state', { hasFile: form.file !== null });
      return;
    }
    if (!userId) {
      log.error('handleUpload', 'no authenticated user');
      setError('You must be signed in to upload.');
      return;
    }

    log.info('handleUpload', 'start', {
      tableName,
      fileSize: form.file.size,
      durationMs: form.durationMs,
    });
    setStep('uploading');
    setError(null);

    let uploadedPath: string | null = null;
    try {
      const pathPrefix = `${uploadPathPrefix}/${userId}`;
      const uploadResult = await uploadAudioToStorage(form.file, pathPrefix);
      uploadedPath = uploadResult.path;
      log.info('handleUpload', 'storage uploaded', { path: uploadedPath });

      const insertPayload = {
        name: trimmedName,
        description: form.description.trim() || null,
        tags: normalizeTags(form.tags) || null,
        loop: form.loop,
        media_url: uploadResult.publicUrl,
        duration: form.durationMs,
        influence: influenceValue,
        source: 0,
      };

      const { data, error: dbErr } = await supabase
        .from(tableName)
        .insert(insertPayload)
        .select('*')
        .single();

      if (dbErr || !data) {
        log.warn('handleUpload', 'db insert failed; cleaning up storage', {
          path: uploadedPath,
          pgCode: dbErr?.code,
          pgMessage: dbErr?.message?.slice(0, 120),
        });
        try {
          if (isStorageServiceEnabled()) {
            await deleteObjects([uploadedPath], STORAGE_BUCKET);
          } else {
            await supabase.storage.from(STORAGE_BUCKET).remove([uploadedPath]);
          }
          log.info('handleUpload', 'orphan storage removed', { path: uploadedPath });
        } catch (cleanupErr) {
          log.warn('handleUpload', 'orphan cleanup failed', {
            path: uploadedPath,
            msg: String(cleanupErr).slice(0, 120),
          });
        }
        throw dbErr ?? new Error('Insert returned no data');
      }

      const item = mapAudioRow(data as AudioRow);
      log.info('handleUpload', 'success', { id: item.id });
      onSaved(item);
      onClose();
    } catch (e) {
      log.error('handleUpload', 'failed', { msg: String(e).slice(0, 200) });
      setError(`Failed to upload ${resourceTitle.toLowerCase()}. Please try again.`);
      setStep('form');
    }
  }, [
    isValid,
    form.file,
    form.durationMs,
    form.description,
    form.tags,
    form.loop,
    trimmedName,
    userId,
    onSaved,
    onClose,
    tableName,
    uploadPathPrefix,
    influenceValue,
    resourceTitle,
  ]);

  const handleDismiss = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) return;
      if (isUploading) {
        log.warn('handleDismiss', 'blocked while uploading');
        return;
      }
      onClose();
    },
    [isUploading, onClose],
  );

  const durationLabel =
    form.durationMs !== null ? `${(form.durationMs / 1000).toFixed(1)}s` : undefined;

  return (
    <Dialog open onOpenChange={handleDismiss}>
      <DialogContent
        className={cn(
          'sm:max-w-[480px] p-0 gap-0',
          isUploading && '[&>button[aria-label=Close]]:hidden',
        )}
        onEscapeKeyDown={(e) => {
          if (isUploading) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (isUploading) e.preventDefault();
        }}
      >
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <UploadIcon className="h-5 w-5 text-primary" />
            Upload
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 pb-4 space-y-5">
          <div className="space-y-1.5">
            <Label
              htmlFor="upload-audio-name"
              className="text-xs font-medium uppercase tracking-wide"
            >
              Name *
            </Label>
            <Input
              id="upload-audio-name"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder={namePlaceholder}
              autoFocus
              maxLength={NAME_MAX}
              disabled={isUploading}
              aria-required
            />
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="upload-audio-description"
              className="text-xs font-medium uppercase tracking-wide"
            >
              Description
            </Label>
            <Textarea
              id="upload-audio-description"
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              placeholder={descriptionPlaceholder}
              rows={3}
              disabled={isUploading}
            />
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="upload-audio-tags"
              className="text-xs font-medium uppercase tracking-wide"
            >
              Tags
            </Label>
            <Input
              id="upload-audio-tags"
              value={form.tags}
              onChange={(e) => setForm((p) => ({ ...p, tags: e.target.value }))}
              placeholder={tagsPlaceholder}
              disabled={isUploading}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label
                htmlFor="upload-audio-loop"
                className="text-xs font-medium uppercase tracking-wide"
              >
                Loop
              </Label>
              <p className="text-xs text-muted-foreground">
                Plays continuously when used in a book.
              </p>
            </div>
            <Switch
              id="upload-audio-loop"
              checked={form.loop}
              onCheckedChange={(checked) => {
                log.debug('handleLoopToggle', 'loop changed', { loop: checked });
                setForm((p) => ({ ...p, loop: checked }));
              }}
              disabled={isUploading}
              aria-label="Loop audio"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium uppercase tracking-wide">
              Audio File *
            </Label>
            <FileDropzone
              file={form.file}
              onPick={handleFilePick}
              onRemove={handleRemoveFile}
              accept={acceptAttr}
              disabled={isUploading}
              metaLabel={durationLabel}
            />
            {form.fileError ? (
              <p className="text-xs text-destructive" role="alert" aria-live="polite">
                {form.fileError}
              </p>
            ) : null}
          </div>

          {error ? (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter className="border-t px-6 py-4 flex-row justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={isUploading}>
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={handleUpload}
            disabled={!isValid || isUploading}
            className="gap-2"
          >
            {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {isUploading ? 'Uploading...' : 'Upload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
