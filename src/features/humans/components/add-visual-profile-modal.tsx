// add-visual-profile-modal.tsx — Modal: multi-image upload (cap 4) + create visual profile.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, X, ImagePlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/features/humans/components/shared/form-field';
import { uploadHumanImage, removeHumanStorageObjects } from '@/apis/human-api';
import type { VisualProfile } from '@/types/human';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('Humans', 'AddVisualProfileModal');

const MAX_IMAGES = 4;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

type Step = 'form' | 'uploading';

interface PendingImage {
  id: string;
  file: File;
  previewUrl: string;
  error: string | null;
}

interface AddVisualProfileModalProps {
  defaultName: string;
  humanId: string;
  onClose: () => void;
  onAdded: (profile: VisualProfile) => Promise<void>;
}

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function validateFile(file: File): string | null {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) return 'Unsupported type';
  if (file.size > MAX_IMAGE_SIZE) return 'Too large (>5MB)';
  return null;
}

export function AddVisualProfileModal({
  defaultName,
  humanId,
  onClose,
  onAdded,
}: AddVisualProfileModalProps) {
  const [name, setName] = useState(defaultName);
  const [ageRaw, setAgeRaw] = useState<string>('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);
  const [uploadedCount, setUploadedCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Revoke all object URLs on unmount.
  useEffect(() => {
    return () => {
      images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parsedAge = useMemo(() => {
    if (ageRaw.trim() === '') return null;
    const n = Number(ageRaw);
    if (!Number.isFinite(n)) return null;
    const i = Math.round(n);
    if (i < 0 || i > 120) return null;
    return i;
  }, [ageRaw]);

  const hasFileErrors = images.some((i) => i.error !== null);
  const isValid =
    name.trim().length >= 1 &&
    name.trim().length <= 255 &&
    parsedAge !== null &&
    images.length >= 1 &&
    images.length <= MAX_IMAGES &&
    !hasFileErrors;

  const remainingSlots = Math.max(0, MAX_IMAGES - images.length);

  const handleAddFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const arr = Array.from(files).slice(0, remainingSlots);
    const next: PendingImage[] = arr.map((file) => ({
      id: genId(),
      file,
      previewUrl: URL.createObjectURL(file),
      error: validateFile(file),
    }));
    setImages((prev) => [...prev, ...next]);
  };

  const handleRemoveImage = (id: string) => {
    setImages((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((i) => i.id !== id);
    });
  };

  const handleAdd = async () => {
    if (!isValid || step === 'uploading' || parsedAge === null) return;
    log.info('handleAdd', 'start', { count: images.length });
    setStep('uploading');
    setError(null);
    setUploadedCount(0);

    const uploadedPaths: string[] = [];
    try {
      const results = await Promise.all(
        images.map(async (img) => {
          const result = await uploadHumanImage(humanId, img.file);
          uploadedPaths.push(result.path);
          setUploadedCount((c) => c + 1);
          return result.publicUrl;
        }),
      );
      const urls: string[] = results;

      const profile: VisualProfile = {
        clientId: genId(),
        name: name.trim(),
        age: parsedAge,
        rawImages: urls,
        nobgImage: null,
        convertedImage: null,
        traits: [],
      };

      images.forEach((img) => URL.revokeObjectURL(img.previewUrl));

      await onAdded(profile);
      log.info('handleAdd', 'done', { count: urls.length });
      onClose();
    } catch (e) {
      log.error('handleAdd', 'failed', { uploadedCount: uploadedPaths.length, error: String(e) });
      if (uploadedPaths.length > 0) {
        await removeHumanStorageObjects(uploadedPaths).catch(() => undefined);
      }
      setError('Failed to add visual profile. Please try again.');
      setStep('form');
      setUploadedCount(0);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (open) return;
    if (step === 'uploading') return;
    onClose();
  };

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Visual Profile</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Name" required>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={255}
              disabled={step === 'uploading'}
            />
          </FormField>

          <FormField label="Age" required>
            <Input
              type="number"
              min={0}
              max={120}
              step={1}
              value={ageRaw}
              onChange={(e) => setAgeRaw(e.target.value)}
              placeholder="0-120"
              disabled={step === 'uploading'}
            />
          </FormField>

          <FormField label={`Images (${images.length}/${MAX_IMAGES})`} required>
            <div className="grid grid-cols-3 gap-2">
              {images.map((img) => (
                <div
                  key={img.id}
                  className={cn(
                    'relative aspect-square overflow-hidden rounded-lg border',
                    img.error ? 'border-destructive' : 'border-border',
                  )}
                >
                  <img
                    src={img.previewUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveImage(img.id)}
                    disabled={step === 'uploading'}
                    aria-label="Remove image"
                    className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-background/80 backdrop-blur text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  {img.error ? (
                    <div className="absolute inset-x-0 bottom-0 bg-destructive/90 px-1 py-0.5 text-center text-[10px] font-medium text-destructive-foreground">
                      {img.error}
                    </div>
                  ) : null}
                </div>
              ))}
              {remainingSlots > 0 ? (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={step === 'uploading'}
                  className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-border text-muted-foreground hover:border-primary hover:bg-accent"
                >
                  <ImagePlus className="h-5 w-5" />
                  <span className="text-xs">Add</span>
                </button>
              ) : null}
              <input
                ref={fileInputRef}
                type="file"
                accept={ALLOWED_IMAGE_TYPES.join(',')}
                multiple
                hidden
                onChange={(e) => {
                  handleAddFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              JPG, PNG, WEBP · up to 5MB each · {MAX_IMAGES} max
            </p>
          </FormField>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={step === 'uploading'}>
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={handleAdd}
            disabled={!isValid || step === 'uploading'}
            className="gap-2"
          >
            {step === 'uploading' ? (
              <>
                <Upload className="h-4 w-4" />
                Creating… ({uploadedCount}/{images.length})
              </>
            ) : (
              'Create'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
