'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from '@/lib/icons';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

export function ScanMultiSelect<T extends string>({
  label,
  description,
  options,
  selected,
  onChange,
  getLabel,
  getMeta,
  placeholder = 'Select…',
  disabled = false,
}: {
  label: string;
  description?: string;
  options: readonly T[];
  selected: T[];
  onChange: (next: T[]) => void;
  getLabel: (value: T) => string;
  getMeta?: (value: T) => string | undefined;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const updateMenuPosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const gap = 4;
    const preferredMaxHeight = 224;
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUp = spaceBelow < 160 && spaceAbove > spaceBelow;
    const maxHeight = Math.min(
      preferredMaxHeight,
      Math.max(120, openUp ? spaceAbove : spaceBelow)
    );
    setMenuStyle({
      top: openUp ? rect.top - gap - maxHeight : rect.bottom + gap,
      left: rect.left,
      width: rect.width,
      maxHeight,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();
    const onScrollOrResize = () => updateMenuPosition();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const summary =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? getLabel(selected[0])
        : `${selected.length} selected`;

  function toggle(value: T) {
    onChange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
    );
  }

  return (
    <div className="space-y-1.5" ref={containerRef}>
      {label ? <Label className="text-[11px]">{label}</Label> : null}
      {description ? (
        <p className="text-[10px] text-muted-foreground">{description}</p>
      ) : null}
      <div>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          disabled={disabled || options.length === 0}
          onClick={() => {
            setOpen((prev) => {
              const next = !prev;
              if (next) updateMenuPosition();
              return next;
            });
          }}
          className="flex h-9 w-full items-center justify-between rounded-lg border border-border bg-background px-3 text-left text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="truncate text-foreground">{summary}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
        {mounted && open && menuStyle
          ? createPortal(
              <div
                ref={menuRef}
                className="fixed z-[200] overflow-y-auto rounded-lg border border-border bg-card p-1 text-card-foreground shadow-xl ring-1 ring-border/60"
                style={{
                  top: menuStyle.top,
                  left: menuStyle.left,
                  width: menuStyle.width,
                  maxHeight: menuStyle.maxHeight,
                }}
              >
                {options.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">No options available.</p>
                ) : (
                  options.map((option) => (
                    <label
                      key={option}
                      className={cn(
                        'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/60',
                        selected.includes(option) && 'bg-muted/80'
                      )}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={selected.includes(option)}
                        onCheckedChange={() => toggle(option)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block">{getLabel(option)}</span>
                        {getMeta?.(option) ? (
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">
                            {getMeta(option)}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ))
                )}
                {selected.length > 0 ? (
                  <button
                    type="button"
                    className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50"
                    onClick={() => onChange([])}
                  >
                    Clear selection
                  </button>
                ) : null}
              </div>,
              document.body
            )
          : null}
      </div>
    </div>
  );
}
