// create-human-modal.tsx — Modal collecting human metadata (no profile uploads).

import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormField } from '@/features/humans/components/shared/form-field';
import { DisplayNameTable } from '@/features/humans/components/shared/display-name-table';
import { normalizeDisplayNames } from '@/features/humans/utils/display-name-helpers';
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_COUNTRIES,
  GENDER_OPTIONS,
} from '@/constants/config-constants';
import { useHumansActions } from '@/stores/humans-store';
import type { Human, HumanGender } from '@/types/human';
import { createLogger } from '@/utils/logger';

const log = createLogger('Humans', 'CreateHumanModal');

const COUNTRY_UNSPECIFIED = '__unspecified__';

interface CreateHumanModalProps {
  onClose: () => void;
  onCreated: (human: Human) => void;
}

type Step = 'form' | 'creating';

interface FormState {
  sourceName: string;
  displayName: Record<string, string>;
  gender: HumanGender;
  country: string;
  description: string;
}

function buildInitialForm(): FormState {
  return {
    sourceName: '',
    displayName: Object.fromEntries(SUPPORTED_LANGUAGES.map((l) => [l.code, ''])),
    gender: null,
    country: '',
    description: '',
  };
}

function parseGender(raw: string): HumanGender {
  if (raw === '0') return 0;
  if (raw === '1') return 1;
  return null;
}

export function CreateHumanModal({ onClose, onCreated }: CreateHumanModalProps) {
  const { createHuman } = useHumansActions();
  const [form, setForm] = useState<FormState>(() => buildInitialForm());
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);

  const isValid = useMemo(() => {
    const len = form.sourceName.trim().length;
    return len >= 1 && len <= 255;
  }, [form.sourceName]);

  const handleDisplayNameChange = (code: string, value: string) => {
    setForm((prev) => ({
      ...prev,
      displayName: { ...prev.displayName, [code]: value },
    }));
  };

  const handleCreate = async () => {
    if (!isValid || step === 'creating') return;
    log.info('handleCreate', 'start');
    setStep('creating');
    setError(null);

    const payload = {
      source_name: form.sourceName.trim(),
      display_name: normalizeDisplayNames(form.displayName, form.sourceName),
      gender: form.gender,
      zodiac: null,
      country: form.country.trim() || null,
      description: form.description.trim() || null,
      visual_profiles: [],
      voice_profiles: [],
    };

    try {
      const human = await createHuman(payload);
      if (!human) {
        log.warn('handleCreate', 'createHuman returned null');
        setError('Failed to create human. Please try again.');
        setStep('form');
        return;
      }
      log.info('handleCreate', 'done', { id: human.id });
      onCreated(human);
    } catch (e) {
      log.error('handleCreate', 'threw', { error: String(e) });
      setError('Failed to create human. Please try again.');
      setStep('form');
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (open) return;
    if (step === 'creating') return;
    onClose();
  };

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Human</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Name" required>
            <Input
              autoFocus
              value={form.sourceName}
              onChange={(e) => setForm((p) => ({ ...p, sourceName: e.target.value }))}
              placeholder="e.g. Alice"
              maxLength={255}
              aria-required
              disabled={step === 'creating'}
            />
          </FormField>

          <FormField label="Display Names">
            <DisplayNameTable
              values={form.displayName}
              languages={SUPPORTED_LANGUAGES}
              onChange={handleDisplayNameChange}
              disabled={step === 'creating'}
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Gender">
              <Select
                value={form.gender === null ? 'null' : String(form.gender)}
                onValueChange={(v) =>
                  setForm((p) => ({ ...p, gender: parseGender(v) }))
                }
                disabled={step === 'creating'}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GENDER_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="Country">
              <Select
                value={form.country || COUNTRY_UNSPECIFIED}
                onValueChange={(v) =>
                  setForm((p) => ({
                    ...p,
                    country: v === COUNTRY_UNSPECIFIED ? '' : v,
                  }))
                }
                disabled={step === 'creating'}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Unspecified" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={COUNTRY_UNSPECIFIED}>Unspecified</SelectItem>
                  {SUPPORTED_COUNTRIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField label="Description">
            <Textarea
              rows={3}
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="Optional notes"
              disabled={step === 'creating'}
            />
          </FormField>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={step === 'creating'}>
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={handleCreate}
            disabled={!isValid || step === 'creating'}
          >
            {step === 'creating' ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
