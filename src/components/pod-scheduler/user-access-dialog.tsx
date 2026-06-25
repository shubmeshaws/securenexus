'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  EMPTY_PERMISSIONS,
  FULL_PERMISSIONS,
  PERMISSION_LABELS,
  type ScheduleAccessMode,
  type UserPermissions,
} from '@/lib/user-permissions';
import { apiFetch, type AdminUser, type Schedule } from '@/lib/api-client';
import { parseClusterDisplay, cn } from '@/lib/utils';

export interface UserAccessSavePayload {
  permissions: UserPermissions;
  scheduleIds: string[];
}

interface UserAccessDialogProps {
  user: AdminUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (userId: string, payload: UserAccessSavePayload) => void;
  saving?: boolean;
}

export function UserAccessDialog({
  user,
  open,
  onOpenChange,
  onSave,
  saving,
}: UserAccessDialogProps) {
  const [draft, setDraft] = useState<UserPermissions>({ ...EMPTY_PERMISSIONS });
  const [selectedScheduleIds, setSelectedScheduleIds] = useState<string[]>([]);
  const [scheduleSearch, setScheduleSearch] = useState('');
  const isAdmin = user?.role === 'admin';

  const { data: schedulesData } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => apiFetch<{ schedules: Schedule[] }>('/api/schedules'),
    enabled: open && !isAdmin,
  });

  useEffect(() => {
    if (!user) return;
    setDraft(
      isAdmin
        ? { ...FULL_PERMISSIONS }
        : {
            scheduleEdit: user.permissions?.scheduleEdit ?? false,
            scheduleStart: user.permissions?.scheduleStart ?? false,
            scheduleStop: user.permissions?.scheduleStop ?? false,
            liveScheduleStop: user.permissions?.liveScheduleStop ?? false,
            instantSchedule: user.permissions?.instantSchedule ?? false,
            scheduleAccessMode: user.permissions?.scheduleAccessMode ?? 'all',
          }
    );
    setSelectedScheduleIds(user.scheduleIds ?? []);
    setScheduleSearch('');
  }, [user, isAdmin]);

  const toggle = (key: keyof UserPermissions, checked: boolean) => {
    if (key === 'scheduleAccessMode') return;
    setDraft((prev) => ({ ...prev, [key]: checked }));
  };

  const setAccessMode = (mode: ScheduleAccessMode) => {
    setDraft((prev) => ({ ...prev, scheduleAccessMode: mode }));
    if (mode === 'all') setSelectedScheduleIds([]);
  };

  const schedules = schedulesData?.schedules ?? [];
  const filteredSchedules = useMemo(() => {
    const q = scheduleSearch.trim().toLowerCase();
    if (!q) return schedules;
    return schedules.filter((s) => {
      const { clusterName } = parseClusterDisplay(s.cluster);
      return (
        s.name.toLowerCase().includes(q) ||
        s.namespace.toLowerCase().includes(q) ||
        clusterName.toLowerCase().includes(q) ||
        s.appName.toLowerCase().includes(q)
      );
    });
  }, [schedules, scheduleSearch]);

  const groupedSchedules = useMemo(() => {
    const map = new Map<string, Schedule[]>();
    for (const schedule of filteredSchedules) {
      const { clusterName } = parseClusterDisplay(schedule.cluster);
      const key = `${clusterName} · ${schedule.namespace}`;
      const list = map.get(key) ?? [];
      list.push(schedule);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredSchedules]);

  const toggleSchedule = (scheduleId: string, checked: boolean) => {
    setSelectedScheduleIds((prev) =>
      checked ? Array.from(new Set([...prev, scheduleId])) : prev.filter((id) => id !== scheduleId)
    );
  };

  const selectAllVisible = () => {
    setSelectedScheduleIds((prev) =>
      Array.from(new Set([...prev, ...filteredSchedules.map((s) => s.id)]))
    );
  };

  const clearSelection = () => setSelectedScheduleIds([]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AppIcon icon={KeyRound} size="sm" />
            Page access
          </DialogTitle>
          <DialogDescription>
            {user ? (
              <>
                Choose what <span className="font-medium text-foreground">{user.displayName}</span>{' '}
                can do on Schedules and which workloads they can access.
              </>
            ) : (
              'Configure user permissions.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Schedule actions
          </p>
          {(['scheduleEdit', 'scheduleStart', 'scheduleStop'] as const).map((key) => (
            <div
              key={key}
              className="flex items-center justify-between rounded-xl border border-border px-4 py-3"
            >
              <span className="text-sm text-foreground">{PERMISSION_LABELS[key]}</span>
              <Switch
                checked={draft[key]}
                onCheckedChange={(checked) => toggle(key, checked)}
                disabled={isAdmin || saving}
                aria-label={PERMISSION_LABELS[key]}
              />
            </div>
          ))}

          <p className="pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Live Schedule
          </p>
          <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
            <span className="text-sm text-foreground">{PERMISSION_LABELS.liveScheduleStop}</span>
            <Switch
              checked={draft.liveScheduleStop}
              onCheckedChange={(checked) => toggle('liveScheduleStop', checked)}
              disabled={isAdmin || saving}
              aria-label={PERMISSION_LABELS.liveScheduleStop}
            />
          </div>

          <p className="pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Instant Schedule
          </p>
          <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
            <span className="text-sm text-foreground">{PERMISSION_LABELS.instantSchedule}</span>
            <Switch
              checked={draft.instantSchedule}
              onCheckedChange={(checked) => toggle('instantSchedule', checked)}
              disabled={isAdmin || saving}
              aria-label={PERMISSION_LABELS.instantSchedule}
            />
          </div>

          <p className="pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Schedule scope
          </p>
          <div className="space-y-2 rounded-xl border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-foreground">All schedules</p>
                <p className="text-[11px] text-muted-foreground">
                  User can access every schedule (subject to action permissions above).
                </p>
              </div>
              <Switch
                checked={draft.scheduleAccessMode === 'all'}
                onCheckedChange={(checked) => setAccessMode(checked ? 'all' : 'selected')}
                disabled={isAdmin || saving}
                aria-label="All schedules"
              />
            </div>
            {draft.scheduleAccessMode === 'selected' ? (
              <div className="space-y-2 border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">
                  Select one or more schedules this user may view, start, and stop.
                </p>
                <Input
                  value={scheduleSearch}
                  onChange={(e) => setScheduleSearch(e.target.value)}
                  placeholder="Search schedule, namespace, cluster…"
                  className="h-8 text-xs"
                  disabled={saving}
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={selectAllVisible}
                    disabled={saving || !filteredSchedules.length}
                  >
                    Select visible
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={clearSelection}
                    disabled={saving || !selectedScheduleIds.length}
                  >
                    Clear
                  </Button>
                  <span className="ml-auto self-center text-[11px] tabular-nums text-muted-foreground">
                    {selectedScheduleIds.length} selected
                  </span>
                </div>
                <div className="max-h-48 space-y-3 overflow-y-auto rounded-lg border border-border bg-muted/20 p-2">
                  {groupedSchedules.length === 0 ? (
                    <p className="p-2 text-xs text-muted-foreground">No schedules match.</p>
                  ) : (
                    groupedSchedules.map(([group, items]) => (
                      <div key={group}>
                        <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {group}
                        </p>
                        <div className="space-y-1">
                          {items.map((schedule) => {
                            const checked = selectedScheduleIds.includes(schedule.id);
                            return (
                              <label
                                key={schedule.id}
                                className={cn(
                                  'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/60',
                                  checked && 'bg-muted/40'
                                )}
                              >
                                <input
                                  type="checkbox"
                                  className="mt-0.5"
                                  checked={checked}
                                  onChange={(e) => toggleSchedule(schedule.id, e.target.checked)}
                                  disabled={saving}
                                />
                                <span>
                                  <span className="font-medium text-foreground">{schedule.name}</span>
                                  <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                                    {schedule.appName}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </div>

          {isAdmin && (
            <p className="text-xs text-muted-foreground">
              Admins always have full access. Change the role to grant custom permissions.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              user &&
              onSave(user.id, {
                permissions: draft,
                scheduleIds:
                  draft.scheduleAccessMode === 'selected' ? selectedScheduleIds : [],
              })
            }
            disabled={
              !user ||
              isAdmin ||
              saving ||
              (draft.scheduleAccessMode === 'selected' && selectedScheduleIds.length === 0)
            }
          >
            Save access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
