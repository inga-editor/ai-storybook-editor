// channel-export-group.tsx — One channel group: label + gated Export button +
// variant rows. Export gating is computed by the parent and passed via
// `canExport`/`anyExporting`. Design §3.2.
//
// Click-to-running gap: backend enqueues a queued job; handler picks it up
// asynchronously (~1-3s typical, up to reaper threshold). During that gap
// `anyExporting` is still false (leaf not yet flipped to 'exporting'). We
// hold a local `isStarting` gate to block double-clicks, releasing on the
// FIRST of: handler picked up (anyExporting flips true), non-progress
// outcome (failed/skipped — parent already toasted), or 5s safety timeout
// (handles network hang / queue backed up — user can retry).

import * as React from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DistributionVariantRow } from './distribution-variant-row';
import { V1_EXPORT_CAPABILITY, type VariantDescriptor } from '../distribution-helpers';
import type { ChannelKey, ExportVariantLeaf, VideoType } from '@/types/editor';
import type { EnqueueExportOutcome } from '@/hooks/use-distribution-actions';
import { formatFileSize } from '../distribution-helpers';
import { createLogger } from '@/utils/logger';

const log = createLogger('Editor', 'ChannelExportGroup');

const START_GATE_TIMEOUT_MS = 5000;

export interface ChannelExportGroupProps {
  label: string;
  channelKey: ChannelKey;
  videoType?: VideoType;
  variants: Array<{ descriptor: VariantDescriptor; leaf: ExportVariantLeaf }>;
  canExport: boolean;
  anyExporting: boolean;
  onExport: () => Promise<EnqueueExportOutcome>;
  onToggleVariant: (leafKey: string, next: boolean) => void;
  onViewVariant: (leafKey: string) => void;
}

export function ChannelExportGroup({
  label,
  channelKey,
  variants,
  canExport,
  anyExporting,
  onExport,
  onToggleVariant,
  onViewVariant,
}: ChannelExportGroupProps) {
  const cap = V1_EXPORT_CAPABILITY[channelKey];

  const [isStarting, setIsStarting] = React.useState(false);

  // Release gate when backend handler picks up the job (leaf flips to exporting).
  React.useEffect(() => {
    if (anyExporting && isStarting) {
      log.debug('startGate', 'released (handler picked up)', { channelKey });
      setIsStarting(false);
    }
  }, [anyExporting, isStarting, channelKey]);

  // 5s safety: queue backed up / network hang → release so user can retry.
  React.useEffect(() => {
    if (!isStarting) return;
    const id = setTimeout(() => {
      log.warn('startGate', 'released (timeout, handler did not pick up)', {
        channelKey,
        timeoutMs: START_GATE_TIMEOUT_MS,
      });
      setIsStarting(false);
    }, START_GATE_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [isStarting, channelKey]);

  const handleExport = async () => {
    if (!canExport || isStarting || anyExporting) return;
    log.info('handleExport', 'export requested', { channelKey, label });
    setIsStarting(true);
    try {
      const outcome = await onExport();
      // failed/skipped — parent already toasted; release immediately so user can retry / read state.
      // enqueued/deduped — keep gating until anyExporting flips or 5s safety fires.
      if (outcome.kind === 'failed' || outcome.kind === 'skipped') {
        log.info('handleExport', 'released early (non-progress outcome)', {
          channelKey,
          outcomeKind: outcome.kind,
        });
        setIsStarting(false);
      }
    } catch (err) {
      log.warn('handleExport', 'enqueue threw', {
        channelKey,
        error: err instanceof Error ? err.message : String(err),
      });
      setIsStarting(false);
    }
  };

  const busy = isStarting || anyExporting;
  const buttonLabel = isStarting ? 'Starting…' : anyExporting ? 'Exporting…' : 'Export';

  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canExport || busy}
          onClick={handleExport}
          className="h-7 gap-1 px-2 text-xs"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {buttonLabel}
        </Button>
      </div>

      <div className="divide-y divide-border/40">
        {variants.map(({ descriptor, leaf }) => (
          <DistributionVariantRow
            key={descriptor.leafKey}
            label={descriptor.label}
            checked={leaf.is_enabled}
            checkboxDisabled={cap.disabledLeafKeys.includes(descriptor.leafKey)}
            fileSizeText={formatFileSize(leaf.file_size)}
            status={leaf.status}
            // Printer artifacts are private (exports/ prefix) — View goes through
            // the signed-URL flow keyed by last_job_id. Pre-feature exports have
            // media_url but no last_job_id → View stays disabled until re-export.
            canView={
              channelKey === 'printer'
                ? leaf.last_job_id != null
                : leaf.media_url != null
            }
            onToggle={(next) => onToggleVariant(descriptor.leafKey, next)}
            onView={() => onViewVariant(descriptor.leafKey)}
          />
        ))}
      </div>
    </div>
  );
}
