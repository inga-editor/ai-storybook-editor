// variant-item.tsx - Accordion item for a single character variant with image gallery + appearance section + generate/edit

import { useRef, useState } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  Upload,
  Paperclip,
  X,
  Check,
  Sparkles,
  Loader2,
} from 'lucide-react';
import { Label } from '@/components/ui/label';
import {
  useSnapshotActions,
  useCharacterByKey,
  useImageTasksForChild,
} from '@/stores/snapshot-store/selectors';
import { useReferenceImagePicker } from '@/features/editor/hooks/use-reference-image-picker';
import { useEnsureEntitySavedBeforeGenerate } from '@/features/editor/hooks/ensure-entity-saved-before-generate';
import type { CharacterAppearance, CharacterVariant } from '@/types/character-types';
import { useCurrentBook } from '@/stores/book-store';
import { uploadImageToStorage } from '@/apis/storage-api';
import { createLogger } from '@/utils/logger';
import { downloadImage } from '@/utils/download-image';
import { cn } from '@/utils/utils';
import { toast } from 'sonner';
import { VariantItemImageArea } from './variant-item-image-area';

const log = createLogger('Editor', 'VariantItem');

// ── Appearance section (inline sub-component to keep variant-item under 500 lines) ──────────────

interface AppearanceSectionProps {
  variantKey: string;
  appearance: CharacterAppearance;
  isExpanded: boolean;
  sectionId: string;
  editable: boolean;
  onToggle: () => void;
  onChange: (field: keyof CharacterAppearance, value: string) => void;
}

function AppearanceSection({
  variantKey,
  appearance,
  isExpanded,
  sectionId,
  editable,
  onToggle,
  onChange,
}: AppearanceSectionProps) {
  const headerId = `${sectionId}-appearance-header`;
  const contentId = `${sectionId}-appearance-content`;
  return (
    <div>
      <button
        id={headerId}
        className="flex items-center gap-2 w-full px-2 py-1.5 text-sm font-medium hover:bg-muted/50 rounded-md transition-colors"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-controls={contentId}
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        <span className="uppercase">Appearance</span>
      </button>

      {isExpanded && (
        <div
          id={contentId}
          role="region"
          aria-labelledby={headerId}
          className="px-2 pt-2 pb-3 space-y-3"
        >
          {/* Row 1: Height + Build (2 columns) */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block uppercase" htmlFor={`${variantKey}-height`}>Height</label>
              <Input id={`${variantKey}-height`} type="number" value={appearance.height || ''} placeholder="e.g. 165" className="h-8 text-sm" aria-label="Height" disabled={!editable} onChange={(e) => onChange('height', e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block uppercase" htmlFor={`${variantKey}-build`}>Build</label>
              <Input id={`${variantKey}-build`} value={appearance.build ?? ''} placeholder="e.g. Athletic" className="h-8 text-sm" aria-label="Build" disabled={!editable} onChange={(e) => onChange('build', e.target.value)} />
            </div>
          </div>
          {/* Row 2: Hair (full width) */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block uppercase" htmlFor={`${variantKey}-hair`}>Hair</label>
            <Input id={`${variantKey}-hair`} value={appearance.hair ?? ''} placeholder="e.g. Long auburn" className="h-8 text-sm" aria-label="Hair" disabled={!editable} onChange={(e) => onChange('hair', e.target.value)} />
          </div>
          {/* Row 3: Eyes (full width) */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block uppercase" htmlFor={`${variantKey}-eyes`}>Eyes</label>
            <Input id={`${variantKey}-eyes`} value={appearance.eyes ?? ''} placeholder="e.g. Green" className="h-8 text-sm" aria-label="Eyes" disabled={!editable} onChange={(e) => onChange('eyes', e.target.value)} />
          </div>
          {/* Row 4: Face (full width) */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block uppercase" htmlFor={`${variantKey}-face`}>Face</label>
            <Input id={`${variantKey}-face`} value={appearance.face ?? ''} placeholder="e.g. Heart-shaped" className="h-8 text-sm" aria-label="Face" disabled={!editable} onChange={(e) => onChange('face', e.target.value)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main VariantItem ──────────────────────────────────────────────────────────────────────────

interface VariantItemProps {
  characterKey: string;
  variantData: CharacterVariant;
  isExpanded: boolean;
  onToggle: () => void;
  /** Collab held-session gate (ADR-044): when false every variant mutation is blocked + disabled. */
  editable: boolean;
}

export function VariantItem({ characterKey, variantData, isExpanded, onToggle, editable }: VariantItemProps) {
  const { deleteCharacterVariant, updateCharacterVariant, startGenerateTask, startEditTask } =
    useSnapshotActions();
  const character = useCharacterByKey(characterKey);
  const book = useCurrentBook();
  const artStyleId = book?.artstyle_id ?? null;
  const { isProcessing } = useImageTasksForChild(characterKey, variantData.key);
  // Pre-generate save gate runs BEFORE the task exists — fold its round-trip into the busy state
  // so the Generate click flips to "Generating" immediately (no dead-button window).
  const { isEnsureSaving, ensureSavedBeforeGenerate } = useEnsureEntitySavedBeforeGenerate('character', characterKey);
  const isBusy = isProcessing || isEnsureSaving;

  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(variantData.name);
  // Selected illustration is DERIVED from the store's is_selected flag (not local state) so an
  // undo/redo restore of the variant node — or a generate/upload/edit completion — is reflected in
  // the preview. Thumbnail click writes is_selected back to the store (handleSelectIllustration),
  // so selection is itself an undoable edit.
  const selectedIllustrationIndex = Math.max(0, variantData.illustrations.findIndex((ill) => ill.is_selected));
  // Visual description is controlled from the store (write-on-change) for the same reason.
  const visualDescription = variantData.visual_description ?? '';
  const [isEditPopoverOpen, setIsEditPopoverOpen] = useState(false);
  const [editPromptText, setEditPromptText] = useState('');
  const [appearanceExpanded, setAppearanceExpanded] = useState(false);

  const generateRefs = useReferenceImagePicker();
  const editRefs = useReferenceImagePicker();

  // type 0 = base variant, cannot be deleted
  const isBase = variantData.type === 0;

  const sortedIllustrations = [...variantData.illustrations].sort(
    (a, b) => new Date(b.created_time).getTime() - new Date(a.created_time).getTime()
  );
  const selectedIllustration = variantData.illustrations[selectedIllustrationIndex];

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!editable) return; // collab gate
    updateCharacterVariant(characterKey, variantData.key, { visual_description: e.target.value });
  };

  const handleSelectIllustration = (index: number) => {
    if (!editable) return; // collab gate — selection persists via is_selected (undoable)
    const target = variantData.illustrations[index];
    if (!target || target.is_selected) return;
    log.debug('handleSelectIllustration', 'select', { characterKey, variantKey: variantData.key, index });
    updateCharacterVariant(characterKey, variantData.key, {
      illustrations: variantData.illustrations.map((ill, i) => ({ ...ill, is_selected: i === index })),
    });
  };

  // Resolve base variant image URL for non-base variants
  const baseVariantImageUrl = !isBase
    ? character?.variants.find((v) => v.type === 0)?.illustrations.find((ill) => ill.is_selected)?.media_url
    : undefined;

  // Non-base variants cannot generate without base illustration; all variants need a book art style.
  // Collab: also disabled unless this editor holds the entity lock (`editable`).
  const isGenerateDisabled = !editable || isBusy || !visualDescription.trim() || !artStyleId || (!isBase && !baseVariantImageUrl);

  const handleGenerate = async () => {
    if (!editable) return; // collab gate
    const trimmedPrompt = visualDescription.trim();
    if (!trimmedPrompt || isBusy) return;
    // Null-guard: require book.artstyle_id (UUID) — contract rejects empty art style with 400.
    if (!artStyleId) {
      log.warn('handleGenerate', 'blocked — missing artStyleId', { characterKey, variantKey: variantData.key });
      toast.error('Select an art style first');
      return;
    }
    log.info('handleGenerate', 'start', { characterKey, variantKey: variantData.key, isBase });
    updateCharacterVariant(characterKey, variantData.key, { visual_description: trimmedPrompt });

    // GATE (spec §4.2): persist the entity BEFORE generate so the BE save_resource directive can
    // anchor the result. Aborts (with a toast) on a peer lock / save failure — never burns an AI call.
    if (!(await ensureSavedBeforeGenerate())) return;

    const referenceImages = generateRefs.images.length > 0
      ? generateRefs.images.map(({ base64Data, mimeType }) => ({ base64Data, mimeType }))
      : undefined;

    if (isBase) {
      startGenerateTask({
        entityType: 'character',
        isBase: true,
        entityKey: characterKey,
        entityName: character?.name ?? characterKey,
        childKey: variantData.key,
        childName: variantData.name,
        basicInfo: character?.basic_info ?? { description: '', gender: '', age: '', category_id: '', role: '' },
        personality: character?.personality ?? { core_essence: '' },
        baseVariant: {
          appearance: variantData.appearance,
          visual_description: trimmedPrompt,
        },
        artStyleId,
        referenceImages,
      });
    } else {
      if (!baseVariantImageUrl) return;
      startGenerateTask({
        entityType: 'character',
        isBase: false,
        entityKey: characterKey,
        entityName: character?.name ?? characterKey,
        childKey: variantData.key,
        childName: variantData.name,
        variantKey: variantData.key,
        variantAppearance: variantData.appearance,
        variantVisualDescription: trimmedPrompt,
        baseVariantImageUrl,
        artStyleId,
        additionalReferenceImages: referenceImages,
      });
    }

    generateRefs.clearImages();
  };

  const handleEditImage = () => {
    if (!editable) return; // collab gate
    const trimmed = editPromptText.trim();
    if (!trimmed || !selectedIllustration || isBusy) return;
    log.info('handleEditImage', 'start', { characterKey, variantKey: variantData.key, refCount: editRefs.images.length });
    setIsEditPopoverOpen(false);
    const referenceImages = editRefs.images.length > 0
      ? editRefs.images.map(({ base64Data, mimeType }) => ({ base64Data, mimeType }))
      : undefined;
    startEditTask({
      entityType: 'character',
      entityKey: characterKey,
      entityName: character?.name ?? characterKey,
      childKey: variantData.key,
      childName: variantData.name,
      prompt: trimmed,
      imageUrl: selectedIllustration.media_url,
      referenceImages,
    });
    setEditPromptText('');
    editRefs.clearImages();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (!editable) return; // collab gate
    log.info('handleUpload', 'start', { characterKey, variantKey: variantData.key, fileName: file.name });
    setIsUploading(true);
    try {
      const result = await uploadImageToStorage(file, `characters/${characterKey}/${variantData.key}`);
      log.info('handleUpload', 'complete', { publicUrl: result.publicUrl });
      const updatedIllustrations = variantData.illustrations.map((ill) => ({ ...ill, is_selected: false }));
      updatedIllustrations.unshift({ media_url: result.publicUrl, created_time: new Date().toISOString(), is_selected: true });
      updateCharacterVariant(characterKey, variantData.key, { illustrations: updatedIllustrations });
      toast.success('Image uploaded successfully');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      log.error('handleUpload', 'failed', { error: msg });
      toast.error(msg);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteVariant = () => {
    if (!editable) return; // collab gate
    log.info('handleDeleteVariant', 'delete', { characterKey, variantKey: variantData.key });
    deleteCharacterVariant(characterKey, variantData.key);
  };

  const handleAppearanceChange = (field: keyof CharacterAppearance, rawValue: string) => {
    if (!editable) return; // collab gate
    const value = field === 'height' ? Number(rawValue) || 0 : rawValue;
    if (value === variantData.appearance[field]) return;
    log.debug('handleAppearanceChange', 'change', { characterKey, variantKey: variantData.key, field });
    updateCharacterVariant(characterKey, variantData.key, {
      appearance: { ...variantData.appearance, [field]: value },
    });
  };

  const sectionId = `variant-panel-${variantData.key}`;
  const headerId = `variant-header-${variantData.key}`;

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      {/* Header row */}
      <div id={headerId} className={cn('flex items-center gap-2 px-2 py-2 border-b border-border/50', isExpanded && 'bg-muted/30')}>
        <CollapsibleTrigger asChild>
          <div className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer group" aria-expanded={isExpanded} aria-controls={sectionId}>
            {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
            <div className="min-w-0">
              {isRenaming ? (
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <Input
                    className="h-7 text-sm flex-1"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        if (editable && renameValue.trim() && renameValue.trim() !== variantData.name) {
                          updateCharacterVariant(characterKey, variantData.key, { name: renameValue.trim() });
                          log.info('handleRename', 'renamed', { variantKey: variantData.key, newName: renameValue.trim() });
                        }
                        setIsRenaming(false);
                      }
                      if (e.key === 'Escape') setIsRenaming(false);
                    }}
                    autoFocus
                  />
                  <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" aria-label="Accept rename"
                    onClick={() => {
                      if (editable && renameValue.trim() && renameValue.trim() !== variantData.name) {
                        updateCharacterVariant(characterKey, variantData.key, { name: renameValue.trim() });
                      }
                      setIsRenaming(false);
                    }}
                  >
                    <Check className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => setIsRenaming(false)} aria-label="Cancel rename">
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-sm truncate">{variantData.name}</span>
                    <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" title={editable ? 'Rename variant' : 'Click this character to edit'} disabled={!editable}
                      onClick={(e) => { e.stopPropagation(); if (!editable) return; setRenameValue(variantData.name); setIsRenaming(true); log.debug('handleStartRename', 'start', { variantKey: variantData.key }); }}
                    >
                      <Pencil className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                  <span className="text-xs text-muted-foreground">/{variantData.key}</span>
                </>
              )}
            </div>
          </div>
        </CollapsibleTrigger>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <input ref={uploadInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onChange={handleFileSelected} className="hidden" />
          <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={isUploading || !editable}
            title={editable ? undefined : 'Click this character to edit'}
            onClick={(e) => { e.stopPropagation(); if (!editable) return; uploadInputRef.current?.click(); }}
          >
            <Upload className="h-3.5 w-3.5" />
            {isUploading ? 'Uploading...' : 'Upload'}
          </Button>

          {/* Delete — only for non-base variants */}
          {!isBase && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" disabled={!editable} onClick={(e) => e.stopPropagation()} title={editable ? 'Delete variant' : 'Click this character to edit'}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Variant</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete &ldquo;{variantData.name}&rdquo;? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={handleDeleteVariant}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <CollapsibleContent id={sectionId} role="region" aria-labelledby={headerId}>
        <div className="space-y-4 px-3 pt-3 pb-3">
          {/* Image preview + thumbnail gallery */}
          <VariantItemImageArea
            editable={editable}
            variantName={variantData.name}
            illustrations={variantData.illustrations}
            sortedIllustrations={sortedIllustrations}
            selectedIllustrationIndex={selectedIllustrationIndex}
            selectedIllustration={selectedIllustration}
            isProcessing={isBusy}
            isEditPopoverOpen={isEditPopoverOpen}
            editPromptText={editPromptText}
            editRefImages={editRefs.images}
            onSelectIllustration={handleSelectIllustration}
            onDownload={async () => {
              if (!selectedIllustration) return;
              try {
                await downloadImage(selectedIllustration.media_url, variantData.name);
              } catch (err) {
                log.error('handleDownload', 'failed', { error: String(err) });
                alert('Failed to download image');
              }
            }}
            onEditPopoverOpenChange={setIsEditPopoverOpen}
            onEditPromptChange={setEditPromptText}
            onEditSubmit={handleEditImage}
            onEditRefPickerOpen={editRefs.openPicker}
            onEditRefRemove={editRefs.removeImage}
            editRefInputRef={editRefs.inputRef}
            editRefHandleFilesSelected={editRefs.handleFilesSelected}
          />

          {/* Visual Description Section */}
          <div>
            <input ref={generateRefs.inputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={generateRefs.handleFilesSelected} className="hidden" />
            <div className="flex items-center gap-2 mb-2">
              <Label className="text-xs text-muted-foreground">VISUAL DESCRIPTION</Label>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={generateRefs.openPicker} disabled={isBusy || !editable} aria-label="Attach reference image">
                <Paperclip className="h-4 w-4" />
              </Button>
              {generateRefs.images.length > 0 && (
                <span className="text-xs text-muted-foreground">{generateRefs.images.length}/5</span>
              )}
            </div>
            {generateRefs.images.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {generateRefs.images.map((img, idx) => (
                  <div key={`gen-ref-${img.label}-${idx}`} className="flex items-center gap-1 px-2 py-1 rounded-md bg-blue-50 text-blue-700 text-xs">
                    <span className="truncate max-w-[120px]">{img.label}</span>
                    <button onClick={() => generateRefs.removeImage(idx)} className="hover:bg-blue-100 rounded" aria-label={`Remove reference ${img.label}`}>
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Textarea
              value={visualDescription}
              onChange={handleDescriptionChange}
              placeholder="Describe the visual appearance..."
              className="min-h-[80px]"
              disabled={isBusy || !editable}
              aria-label="Visual description prompt"
            />
          </div>

          {/* Generate button */}
          <div className="flex flex-col items-center gap-1">
            <Button onClick={handleGenerate} disabled={isGenerateDisabled} title={!artStyleId ? 'Select an art style first' : undefined} className="w-40" aria-disabled={isGenerateDisabled}>
              {isBusy ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Generating</>
              ) : (
                <><Sparkles className="h-4 w-4 mr-2" />Generate</>
              )}
            </Button>
            {!artStyleId && (
              <span className="text-xs text-muted-foreground">Select an art style first</span>
            )}
            {!isBase && !baseVariantImageUrl && (
              <span className="text-xs text-muted-foreground">Generate base variant first</span>
            )}
          </div>

          {/* Appearance Section — collapsible, default collapsed */}
          <AppearanceSection
            variantKey={variantData.key}
            appearance={variantData.appearance}
            isExpanded={appearanceExpanded}
            sectionId={sectionId}
            editable={editable}
            onToggle={() => setAppearanceExpanded((v) => !v)}
            onChange={handleAppearanceChange}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
