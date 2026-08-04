// config-section-header.tsx — standard header for EVERY config section panel: title on the
// left, optional bulk actions, then a [Save] button on the right. Replaces the ad-hoc
// `h-14 border-b` headings across all sections.
//
// The [Save] button is ALWAYS rendered (never hidden — [feedback: never hide disabled UI]);
// it is disabled when clean, saving, or explicitly `disabled` (Phase 3: while a job runs).

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { cn } from '@/utils/utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ConfigSectionHeader');

export interface ConfigSectionHeaderProps {
  title: string;
  isDirty: boolean;
  isSaving: boolean;
  onSave: () => void;
  /** Bulk actions rendered BEFORE [Save] (e.g. Spread Pool Generate/Translate). */
  actionsSlot?: React.ReactNode;
  /** Force-disable [Save] even when dirty (Phase 3: thumbnail job in flight). */
  disabled?: boolean;
}

export function ConfigSectionHeader({
  title,
  isDirty,
  isSaving,
  onSave,
  actionsSlot,
  disabled = false,
}: ConfigSectionHeaderProps) {
  const saveDisabled = disabled || isSaving || !isDirty;

  const handleSave = () => {
    if (saveDisabled) {
      log.debug('handleSave', 'ignored — save disabled', { isDirty, isSaving, disabled });
      return;
    }
    log.info('handleSave', 'save requested', { title });
    // save() re-throws on persist failure (contract for resolveSave/ensureSaved). The header is
    // a fire-and-forget UI trigger — the hook already toasts + logs — so swallow the rejection
    // here to avoid an unhandledrejection on the most-used save path.
    void Promise.resolve(onSave()).catch(() => {});
  };

  return (
    <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="flex items-center gap-2">
        {actionsSlot}
        <Button
          type="button"
          size="sm"
          variant={isDirty && !isSaving ? 'default' : 'outline'}
          disabled={saveDisabled}
          onClick={handleSave}
          className={cn(!isDirty && !isSaving && 'text-muted-foreground')}
        >
          {isSaving ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              {isDirty && (
                <span
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current"
                  aria-hidden
                />
              )}
              Save
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
