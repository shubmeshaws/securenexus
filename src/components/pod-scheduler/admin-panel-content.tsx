'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UsersRound,
  KeyRound,
} from '@/lib/icons';
import { AppIcon } from '@/components/ui/app-icon';
import { AdminSettingsPanel } from '@/components/pod-scheduler/admin-settings-panel';
import { cn } from '@/lib/utils';
import { apiFetch, type AdminUser } from '@/lib/api-client';
import { POLL_INTERVAL } from '@/components/providers/query-provider';
import { PageHeader, StatCard, GlassPanel, UserAvatar } from '@/components/pod-scheduler/ui-primitives';
import { ConfirmDialog } from '@/components/pod-scheduler/confirm-dialog';
import { UserAccessDialog } from '@/components/pod-scheduler/user-access-dialog';
import { useSession } from '@/components/auth/session-context';
import { ROLE_LABELS, type AppRole, type UserPermissions } from '@/lib/permissions';
import { normalizeAppRole } from '@/lib/user-permissions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatRelativeTime } from '@/lib/utils';
import { filterUsersByQuery } from '@/lib/user-search';

const ROLE_COLORS: Record<string, 'automated' | 'manual' | 'success'> = {
  admin: 'automated',
  analyst: 'manual',
  viewer: 'success',
};

type AdminTab = 'users' | 'settings';

export function AdminPanelContent() {
  const queryClient = useQueryClient();
  const session = useSession();
  const [tab, setTab] = useState<AdminTab>('users');
  const [deleteUser, setDeleteUser] = useState<AdminUser | null>(null);
  const [roleConfirm, setRoleConfirm] = useState<{
    user: AdminUser;
    newRole: AppRole;
  } | null>(null);
  const [accessUser, setAccessUser] = useState<AdminUser | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => apiFetch<{ users: AdminUser[] }>('/api/admin/users'),
    refetchInterval: POLL_INTERVAL,
    enabled: Boolean(session?.active && session.role === 'admin'),
    retry: false,
  });

  const users = useMemo(() => data?.users ?? [], [data?.users]);
  const filteredUsers = useMemo(
    () => filterUsersByQuery(users, searchQuery),
    [users, searchQuery]
  );

  const updateUserMutation = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: Partial<Pick<AdminUser, 'role' | 'active'>> & { permissions?: UserPermissions };
    }) => apiFetch(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    onMutate: async ({ id, body }) => {
      await queryClient.cancelQueries({ queryKey: ['admin-users'] });
      const previous = queryClient.getQueryData<{ users: AdminUser[] }>(['admin-users']);
      if (previous) {
        queryClient.setQueryData(['admin-users'], {
          users: previous.users.map((user) =>
            user.id === id ? { ...user, ...body } : user
          ),
        });
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['admin-users'], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      queryClient.invalidateQueries({ queryKey: ['auth-me'] });
      setRoleConfirm(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/admin/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setDeleteUser(null);
    },
  });

  const handleAccessToggle = (user: AdminUser, active: boolean) => {
    if (user.id === session?.id && !active) return;
    updateUserMutation.mutate({ id: user.id, body: { active } });
  };

  const handleRoleSelect = (user: AdminUser, newRole: AppRole) => {
    if (newRole === user.role) return;
    setRoleConfirm({ user, newRole });
  };

  const confirmRoleChange = () => {
    if (!roleConfirm) return;
    updateUserMutation.mutate({
      id: roleConfirm.user.id,
      body: { role: roleConfirm.newRole },
    });
  };

  const saveUserAccess = (userId: string, permissions: UserPermissions) => {
    updateUserMutation.mutate({ id: userId, body: { permissions } });
    setAccessUser(null);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Admin Panel"
        description="Manage SSO users, roles, and platform settings."
      />

      <div className="flex gap-2 border-b border-border pb-1">
        <button
          type="button"
          onClick={() => setTab('users')}
          className={cn(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
            tab === 'users' ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200/80 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-0' : 'text-zinc-600 hover:bg-zinc-100 dark:text-muted-foreground dark:hover:bg-accent'
          )}
        >
          <AppIcon icon={UsersRound} size="sm" />
          Users
        </button>
        <button
          type="button"
          onClick={() => setTab('settings')}
          className={cn(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
            tab === 'settings' ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200/80 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-0' : 'text-zinc-600 hover:bg-zinc-100 dark:text-muted-foreground dark:hover:bg-accent'
          )}
        >
          <AppIcon icon={SlidersHorizontal} size="sm" />
          Settings
        </button>
      </div>

      {tab === 'settings' ? (
        <AdminSettingsPanel />
      ) : (
        <>
          <div className="grid w-full grid-cols-3 gap-3">
            <StatCard label="Total Users" value={users.length} icon={UsersRound} accent="blue" />
            <StatCard label="Admins" value={users.filter((u) => u.role === 'admin').length} icon={ShieldCheck} accent="sky" />
            <StatCard label="Access Enabled" value={users.filter((u) => u.active).length} icon={UsersRound} accent="emerald" />
          </div>

          {isLoading ? (
            <div className="flex justify-center py-20">
              <Loader2 className="h-7 w-7 animate-spin text-blue-500/50" />
            </div>
          ) : (
            <GlassPanel className="overflow-hidden">
              <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <AppIcon icon={UsersRound} size="sm" className="text-blue-500" />
                  <h2 className="text-sm font-semibold text-foreground">All Users</h2>
                  {searchQuery.trim() && (
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      {filteredUsers.length} of {users.length}
                    </Badge>
                  )}
                </div>
                <div className="relative w-full sm:max-w-xs">
                  <AppIcon
                    icon={ScanSearch}
                    size="sm"
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search users…"
                    className="pl-9"
                    aria-label="Search users"
                  />
                </div>
              </div>
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full text-sm table-modern">
                  <thead>
                    <tr className="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th className="text-left px-5 py-3.5 font-medium">User</th>
                      <th className="text-left px-5 py-3.5 font-medium">Email</th>
                      <th className="text-left px-5 py-3.5 font-medium">Role</th>
                      <th className="text-left px-5 py-3.5 font-medium">Access</th>
                      <th className="text-left px-5 py-3.5 font-medium">Last Login</th>
                      <th className="text-right px-5 py-3.5 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-5 py-10 text-center text-sm text-muted-foreground">
                          {searchQuery.trim()
                            ? `No users match "${searchQuery.trim()}".`
                            : 'No users found.'}
                        </td>
                      </tr>
                    ) : (
                      filteredUsers.map((user) => {
                        const role = normalizeAppRole(user.role);
                        return (
                      <tr key={user.id} className="group border-b border-border">
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <UserAvatar name={user.displayName || user.email || 'User'} size="sm" />
                            <span className="text-sm font-medium text-foreground">
                              {user.displayName || user.email || 'User'}
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-4 font-mono text-xs text-muted-foreground">{user.email}</td>
                        <td className="px-5 py-4">
                          <Select
                            key={`${user.id}-${role}`}
                            defaultValue={role}
                            onValueChange={(value) => handleRoleSelect(user, value as AppRole)}
                            disabled={user.id === session?.id || updateUserMutation.isPending}
                          >
                            <SelectTrigger className="h-8 w-[132px] text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">{ROLE_LABELS.admin}</SelectItem>
                              <SelectItem value="analyst">{ROLE_LABELS.analyst}</SelectItem>
                              <SelectItem value="viewer">{ROLE_LABELS.viewer}</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={user.active}
                              onCheckedChange={(checked) => handleAccessToggle(user, checked)}
                              disabled={user.id === session?.id || updateUserMutation.isPending}
                              aria-label={`Toggle access for ${user.displayName}`}
                            />
                            <Badge variant={user.active ? 'success' : 'failed'}>
                              {user.active ? 'Enabled' : 'Disabled'}
                            </Badge>
                          </div>
                        </td>
                        <td className="px-5 py-4 text-xs text-muted-foreground">
                          {user.lastLogin ? formatRelativeTime(user.lastLogin) : 'Never'}
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex items-center justify-end gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Page access"
                              onClick={() => setAccessUser(user)}
                            >
                              <AppIcon icon={KeyRound} size="sm" className="text-blue-500/80" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Delete"
                              disabled={user.id === session?.id || deleteMutation.isPending}
                              onClick={() => setDeleteUser(user)}
                            >
                              <AppIcon icon={Trash2} size="sm" className="text-red-400/70" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </GlassPanel>
          )}

          <ConfirmDialog
            open={roleConfirm !== null}
            onOpenChange={(open) => !open && setRoleConfirm(null)}
            title="Change user role?"
            description={
              roleConfirm ? (
                <>
                  Change <span className="font-medium text-foreground">{roleConfirm.user.displayName}</span> from{' '}
                  <span className="font-medium text-foreground">{ROLE_LABELS[roleConfirm.user.role]}</span> to{' '}
                  <span className="font-medium text-foreground">{ROLE_LABELS[roleConfirm.newRole]}</span>?
                  This updates permissions immediately.
                </>
              ) : (
                ''
              )
            }
            confirmLabel="Change role"
            destructive={false}
            onConfirm={confirmRoleChange}
            loading={updateUserMutation.isPending}
          />

          <ConfirmDialog
            open={deleteUser !== null}
            onOpenChange={(open) => !open && setDeleteUser(null)}
            title="Delete user?"
            description={
              deleteUser ? (
                <>
                  Permanently remove <span className="font-medium text-foreground">{deleteUser.displayName}</span> (
                  {deleteUser.email})? This cannot be undone.
                </>
              ) : (
                ''
              )
            }
            confirmLabel="Delete"
            onConfirm={() => deleteUser && deleteMutation.mutate(deleteUser.id)}
            loading={deleteMutation.isPending}
          />

          <UserAccessDialog
            user={accessUser}
            open={accessUser !== null}
            onOpenChange={(open) => !open && setAccessUser(null)}
            onSave={saveUserAccess}
            saving={updateUserMutation.isPending}
          />
        </>
      )}
    </div>
  );
}
