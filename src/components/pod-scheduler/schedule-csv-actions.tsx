'use client';

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FileUp, Loader2 } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getApiBaseUrl } from '@/lib/client-settings';
import { apiFetch, getAuthToken } from '@/lib/api-client';
import type { ScheduleCsvImportResult } from '@/lib/schedule-csv';

export function ScheduleCsvActions() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ScheduleCsvImportResult | null>(null);

  async function downloadCsv() {
    setExporting(true);
    try {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${getApiBaseUrl()}/api/schedules/export`, {
        credentials: 'include',
        headers,
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `schedules-${stamp}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setImporting(true);
    try {
      const csv = await file.text();
      const result = await apiFetch<ScheduleCsvImportResult>('/api/schedules/import', {
        method: 'POST',
        body: JSON.stringify({ csv }),
      });
      setImportResult(result);
      if (result.created > 0) {
        queryClient.invalidateQueries({ queryKey: ['schedules'] });
        queryClient.invalidateQueries({ queryKey: ['schedules-live'] });
        queryClient.invalidateQueries({ queryKey: ['overview'] });
      }
    } catch (err) {
      setImportResult({
        created: 0,
        failed: 1,
        errors: [
          {
            row: 0,
            name: file.name,
            error: err instanceof Error ? err.message : 'Import failed',
          },
        ],
      });
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={handleFileChange}
      />
      <Button size="sm" variant="outline" onClick={downloadCsv} disabled={exporting || importing}>
        {exporting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <AppIcon icon={Download} size="sm" />
        )}
        Export CSV
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => fileInputRef.current?.click()}
        disabled={exporting || importing}
      >
        {importing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <AppIcon icon={FileUp} size="sm" />
        )}
        Import CSV
      </Button>

      <Dialog open={importResult !== null} onOpenChange={(open) => !open && setImportResult(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import complete</DialogTitle>
            <DialogDescription>
              {importResult?.created ?? 0} schedule(s) created
              {(importResult?.failed ?? 0) > 0 ? `, ${importResult?.failed} failed` : ''}.
            </DialogDescription>
          </DialogHeader>
          {(importResult?.errors.length ?? 0) > 0 && (
            <ul className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 text-sm">
              {importResult?.errors.map((entry) => (
                <li key={`${entry.row}-${entry.name}`}>
                  <span className="font-medium text-foreground">
                    Row {entry.row}
                    {entry.name ? ` (${entry.name})` : ''}:
                  </span>{' '}
                  <span className="text-muted-foreground">{entry.error}</span>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button onClick={() => setImportResult(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
