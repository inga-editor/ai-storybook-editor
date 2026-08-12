// storage-api.ts - Upload files to Supabase Storage (storybook-assets bucket)

import { supabase } from '@/apis/supabase';
import { createLogger } from '@/utils/logger';
import {
  type AspectRatio,
  MIN_SUPPORTED_RATIO,
} from '@/constants/aspect-ratio-constants';
import { normalizeImage } from './image-api';
import type { SaveResourceDirective, SaveResourceOutcomeFields } from '@/types/save-resource';

const log = createLogger('API', 'Storage');

const BUCKET = 'storybook-assets';

const IMAGE_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];

const VIDEO_MAX_SIZE = 50 * 1024 * 1024; // 50MB
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

const AUDIO_MAX_SIZE = 20 * 1024 * 1024; // 20MB
const AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/aac'];

const AUTO_PIC_MAX_SIZE = 50 * 1024 * 1024; // 50MB — webm HD; .gif blocked (validation session 1)
const AUTO_PIC_TYPES = ['image/webp', 'video/webm'];

export interface UploadResult extends SaveResourceOutcomeFields {
  publicUrl: string;
  path: string;
  ratio?: AspectRatio;
}

async function uploadToStorage(
  file: File,
  allowedTypes: string[],
  maxSize: number,
  pathPrefix: string,
  fnName: string,
  // When provided, skips MIME validation (caller has validated by extension) and uses this content type
  validatedContentType?: string,
): Promise<UploadResult> {
  if (!validatedContentType && !allowedTypes.includes(file.type)) {
    throw new Error(`Unsupported file type: ${file.type}. Allowed: ${allowedTypes.join(', ')}`);
  }
  if (file.size > maxSize) {
    throw new Error(`File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: ${maxSize / 1024 / 1024}MB`);
  }

  const sanitizedName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = `${pathPrefix}/${Date.now()}-${sanitizedName}`;

  log.info(fnName, 'uploading', { path: filePath, size: file.size, type: validatedContentType ?? file.type });

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .upload(filePath, file, {
      contentType: validatedContentType ?? file.type,
      upsert: false,
    });

  if (error) {
    log.error(fnName, 'upload failed', { path: filePath, error: error.message });
    throw error;
  }

  const { data: urlData } = supabase.storage
    .from(BUCKET)
    .getPublicUrl(data.path);

  log.info(fnName, 'upload complete', { publicUrl: urlData.publicUrl });

  return { publicUrl: urlData.publicUrl, path: data.path };
}

// ── Image upload seam (ADR-052 sub-app port) ─────────────────────────────────
// Only the generic image upload is swappable: the editor uploads straight to
// Supabase Storage (default below); the remix-editor sub-app has no supabase
// client and instead POSTs to `POST /api/editor/assets`. Video/audio/auto-pic
// uploads stay Supabase-direct (not reachable from the sub-app's eraser flow).

export type ImageUploader = (file: File, pathPrefix?: string) => Promise<UploadResult>;

/** Default (editor) uploader — the original Supabase Storage path, unchanged. */
async function defaultSupabaseImageUploader(file: File, pathPrefix = 'uploads'): Promise<UploadResult> {
  return uploadToStorage(file, IMAGE_TYPES, IMAGE_MAX_SIZE, pathPrefix, 'uploadImageToStorage');
}

let imageUploader: ImageUploader = defaultSupabaseImageUploader;

/** Override the image uploader (sub-app → swap-service asset endpoint). */
export function setImageUploader(uploader: ImageUploader): void {
  log.info('setImageUploader', 'image uploader overridden');
  imageUploader = uploader;
}

export async function uploadImageToStorage(file: File, pathPrefix = 'uploads'): Promise<UploadResult> {
  return imageUploader(file, pathPrefix);
}

export async function uploadVideoToStorage(file: File, pathPrefix = 'videos'): Promise<UploadResult> {
  return uploadToStorage(file, VIDEO_TYPES, VIDEO_MAX_SIZE, pathPrefix, 'uploadVideoToStorage');
}

export async function uploadAudioToStorage(file: File, pathPrefix = 'audios'): Promise<UploadResult> {
  return uploadToStorage(file, AUDIO_TYPES, AUDIO_MAX_SIZE, pathPrefix, 'uploadAudioToStorage');
}

export async function uploadAutoPicToStorage(file: File, pathPrefix = 'auto-pics'): Promise<UploadResult> {
  const lowerName = file.name.toLowerCase();
  // .lottie/.riv have no standard MIME type — browsers report empty string or application/octet-stream.
  // Validate by extension here; pass validatedContentType to skip MIME check in uploadToStorage.
  if (lowerName.endsWith('.lottie') || lowerName.endsWith('.riv')) {
    return uploadToStorage(file, AUTO_PIC_TYPES, AUTO_PIC_MAX_SIZE, pathPrefix, 'uploadAutoPicToStorage', 'application/octet-stream');
  }
  return uploadToStorage(file, AUTO_PIC_TYPES, AUTO_PIC_MAX_SIZE, pathPrefix, 'uploadAutoPicToStorage');
}

// --- Normalize-ratio upload flow ---

export class ImageTooTallError extends Error {
  readonly srcRatio: number;
  constructor(srcRatio: number) {
    super(`Image too tall: ratio ${srcRatio.toFixed(4)} is below minimum ${MIN_SUPPORTED_RATIO.toFixed(4)} (9:16). Please crop and try again.`);
    this.name = 'ImageTooTallError';
    this.srcRatio = srcRatio;
  }
}

/**
 * Upload image and normalize its aspect ratio via FastAPI image-api (1-step multipart).
 * Server decides passthrough/pad/reject — no client-side ratio pre-check.
 * Throws ImageTooTallError for images below 9:16, generic Error for other failures.
 */
export async function uploadImageToStorageWithNormalize(
  file: File,
  outputPrefix = 'uploads',
  saveResource?: SaveResourceDirective,
): Promise<UploadResult> {
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new Error(`Unsupported file type: ${file.type}. Allowed: ${IMAGE_TYPES.join(', ')}`);
  }
  if (file.size > IMAGE_MAX_SIZE) {
    throw new Error(`File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: ${IMAGE_MAX_SIZE / 1024 / 1024}MB`);
  }

  log.info('uploadImageToStorageWithNormalize', 'start', { name: file.name, size: file.size, type: file.type, outputPrefix });

  // Thread the opt-in directive into the multipart normalize call; normalizeImage handles the
  // soft-fail warn. The persist outcome flags travel back on UploadResult for the caller/slice.
  const result = await normalizeImage(file, outputPrefix, saveResource);

  if (result.success) {
    log.info('uploadImageToStorageWithNormalize', 'done', {
      path: result.data.path,
      ratio: result.data.ratio,
      wasPadded: result.data.wasPadded,
      wasConverted: result.data.wasConverted,
      wasPassthrough: result.data.wasPassthrough,
    });
    return {
      publicUrl: result.data.publicUrl,
      path: result.data.path,
      ratio: result.data.ratio ?? undefined,
      saved: result.data.saved,
      saveError: result.data.saveError,
      snapshotId: result.data.snapshotId,
    };
  }

  if (result.errorCode === 'IMAGE_TOO_TALL') {
    throw new ImageTooTallError(result.srcRatio ?? 0);
  }

  log.error('uploadImageToStorageWithNormalize', 'failed', { errorCode: result.errorCode, httpStatus: result.httpStatus, error: result.error });
  throw new Error(result.error);
}
