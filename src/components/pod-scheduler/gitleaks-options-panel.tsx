'use client';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  GITLEAKS_SCAN_MODES,
  type GitleaksScanMode,
  type GitleaksScanOptions,
} from '@/lib/security/gitleaks-options';

export function GitleaksOptionsPanel({
  value,
  onChange,
  disabled = false,
}: {
  value: GitleaksScanOptions;
  onChange: (value: GitleaksScanOptions) => void;
  disabled?: boolean;
}) {
  const active = GITLEAKS_SCAN_MODES.find((row) => row.id === value.mode) ?? GITLEAKS_SCAN_MODES[0];

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
      <div className="space-y-1.5">
        <Label className="text-[10px] font-medium text-foreground">Scan mode</Label>
        <Select
          value={value.mode}
          disabled={disabled}
          onValueChange={(mode) => onChange({ mode: mode as GitleaksScanMode })}
        >
          <SelectTrigger className="h-8 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GITLEAKS_SCAN_MODES.map((row) => (
              <SelectItem key={row.id} value={row.id} className="text-xs">
                {row.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">{active.description}</p>
      <p className="font-mono text-[9px] text-muted-foreground/80">{active.command}</p>
    </div>
  );
}
