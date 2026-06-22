'use client';

import { useEffect, useState } from 'react';
import { KeyRound } from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
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
  type UserPermissions,
} from '@/lib/user-permissions';
import type { AdminUser } from '@/lib/api-client';

const PERMISSION_KEYS = Object.keys(PERMISSION_LABELS) as (keyof UserPermissions)[];

interface UserAccessDialogProps {
  user: AdminUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (userId: string, permissions: UserPermissions) => void;
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
  const isAdmin = user?.role === 'admin';

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
          }
    );
  }, [user, isAdmin]);

  const toggle = (key: keyof UserPermissions, checked: boolean) => {
    setDraft((prev) => ({ ...prev, [key]: checked }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AppIcon icon={KeyRound} size="sm" />
            Page access
          </DialogTitle>
          <DialogDescription>
            {user ? (
              <>
                Choose what <span className="font-medium text-foreground">{user.displayName}</span> can
                do on Schedules and Live Schedules.
              </>
            ) : (
              'Configure user permissions.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Schedule
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
            onClick={() => user && onSave(user.id, draft)}
            disabled={!user || isAdmin || saving}
          >
            Save access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
