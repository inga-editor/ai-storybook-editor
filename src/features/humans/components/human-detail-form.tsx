// human-detail-form.tsx — Inline-edit metadata form. Commits onBlur (text) / onChange (selects).

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
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
import { useBeforeUnloadWarning } from '@/features/humans/hooks/use-before-unload-warning';
import { normalizeDisplayNames } from '@/features/humans/utils/display-name-helpers';
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_COUNTRIES,
  GENDER_OPTIONS,
  ZODIAC_OPTIONS,
} from '@/constants/config-constants';
import type { Human, HumanGender, HumanMetadataPatch } from '@/types/human';
import { createLogger } from '@/utils/logger';

const log = createLogger('Humans', 'HumanDetailForm');

const COUNTRY_UNSPECIFIED = '__unspecified__';

interface HumanDetailFormProps {
  human: Human;
  onChange: (patch: HumanMetadataPatch) => void;
}

function parseGender(raw: string): HumanGender {
  if (raw === '0') return 0;
  if (raw === '1') return 1;
  return null;
}

function parseZodiac(raw: string): number | null {
  if (raw === 'null') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

function shallowEqualMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

export function HumanDetailForm({ human, onChange }: HumanDetailFormProps) {
  const [trackedId, setTrackedId] = useState(human.id);
  const [localSourceName, setLocalSourceName] = useState(human.sourceName);
  const [localDisplayName, setLocalDisplayName] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(SUPPORTED_LANGUAGES.map((l) => [l.code, ''])),
    ...human.displayName,
  }));
  const [localDescription, setLocalDescription] = useState(human.description ?? '');

  // Resync local mirror when human id changes (route nav between humans).
  // Per React docs "adjusting state when a prop changes" — done during render, not effect.
  if (human.id !== trackedId) {
    setTrackedId(human.id);
    setLocalSourceName(human.sourceName);
    setLocalDisplayName({
      ...Object.fromEntries(SUPPORTED_LANGUAGES.map((l) => [l.code, ''])),
      ...human.displayName,
    });
    setLocalDescription(human.description ?? '');
  }

  const isDirty = useMemo(() => {
    if (localSourceName !== human.sourceName) return true;
    if ((localDescription.trim() || null) !== (human.description ?? null)) return true;
    const normalized = normalizeDisplayNames(localDisplayName, localSourceName);
    if (!shallowEqualMap(normalized, human.displayName ?? {})) return true;
    return false;
  }, [localSourceName, localDescription, localDisplayName, human]);

  useBeforeUnloadWarning(isDirty);

  const commitSourceName = () => {
    const trimmed = localSourceName.trim();
    if (trimmed === human.sourceName) return;
    if (trimmed.length < 1 || trimmed.length > 255) {
      log.warn('commitSourceName', 'invalid length; reverting', { length: trimmed.length });
      setLocalSourceName(human.sourceName);
      toast.error('Name must be 1-255 characters.');
      return;
    }
    onChange({ sourceName: trimmed });
  };

  const commitDisplayName = () => {
    const normalized = normalizeDisplayNames(localDisplayName, localSourceName);
    if (shallowEqualMap(normalized, human.displayName ?? {})) return;
    onChange({ displayName: normalized });
  };

  const commitDescription = () => {
    const next = localDescription.trim() || null;
    if (next === (human.description ?? null)) return;
    onChange({ description: next });
  };

  return (
    <section className="space-y-4 px-6 py-4">
      <FormField label="Name" required>
        <Input
          value={localSourceName}
          onChange={(e) => setLocalSourceName(e.target.value)}
          onBlur={commitSourceName}
          maxLength={255}
          aria-required
        />
      </FormField>

      <FormField label="Display Names">
        <DisplayNameTable
          values={localDisplayName}
          languages={SUPPORTED_LANGUAGES}
          onChange={(code, value) =>
            setLocalDisplayName((prev) => ({ ...prev, [code]: value }))
          }
          onBlur={commitDisplayName}
        />
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Gender">
          <Select
            value={human.gender === null ? 'null' : String(human.gender)}
            onValueChange={(v) => onChange({ gender: parseGender(v) })}
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
            value={human.country || COUNTRY_UNSPECIFIED}
            onValueChange={(v) =>
              onChange({ country: v === COUNTRY_UNSPECIFIED ? null : v })
            }
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

      <FormField label="Zodiac">
        <Select
          value={human.zodiac === null ? 'null' : String(human.zodiac)}
          onValueChange={(v) => onChange({ zodiac: parseZodiac(v) })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Unspecified" />
          </SelectTrigger>
          <SelectContent>
            {ZODIAC_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <FormField label="Description">
        <Textarea
          rows={3}
          value={localDescription}
          onChange={(e) => setLocalDescription(e.target.value)}
          onBlur={commitDescription}
          placeholder="Optional notes"
        />
      </FormField>
    </section>
  );
}
