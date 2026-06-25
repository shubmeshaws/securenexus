export type ScheduleAccessMode = 'all' | 'selected';

export interface UserPermissions {
  scheduleEdit: boolean;
  scheduleStart: boolean;
  scheduleStop: boolean;
  liveScheduleStop: boolean;
  instantSchedule: boolean;
  /** When "selected", user may only view/act on schedules in their grant list. */
  scheduleAccessMode: ScheduleAccessMode;
}

export const EMPTY_PERMISSIONS: UserPermissions = {
  scheduleEdit: false,
  scheduleStart: false,
  scheduleStop: false,
  liveScheduleStop: false,
  instantSchedule: false,
  scheduleAccessMode: 'all',
};

export const FULL_PERMISSIONS: UserPermissions = {
  scheduleEdit: true,
  scheduleStart: true,
  scheduleStop: true,
  liveScheduleStop: true,
  instantSchedule: true,
  scheduleAccessMode: 'all',
};

/** Default permissions for new Google SSO users (viewer role). */
export const DEFAULT_NEW_USER_PERMISSIONS: UserPermissions = {
  scheduleEdit: false,
  scheduleStart: false,
  scheduleStop: false,
  liveScheduleStop: true,
  instantSchedule: false,
  scheduleAccessMode: 'all',
};

export const PERMISSION_LABELS: Record<keyof UserPermissions, string> = {
  scheduleEdit: 'Schedule — Edit',
  scheduleStart: 'Schedule — Start',
  scheduleStop: 'Schedule — Stop',
  liveScheduleStop: 'Live Schedule — Stop',
  instantSchedule: 'Instant Schedule',
  scheduleAccessMode: 'Schedule access scope',
};

export function parseScheduleAccessMode(raw: unknown): ScheduleAccessMode {
  return raw === 'selected' ? 'selected' : 'all';
}

export function parseUserPermissions(raw: unknown): UserPermissions {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PERMISSIONS };
  const obj = raw as Record<string, unknown>;
  return {
    scheduleEdit: Boolean(obj.scheduleEdit),
    scheduleStart: Boolean(obj.scheduleStart),
    scheduleStop: Boolean(obj.scheduleStop),
    liveScheduleStop: Boolean(obj.liveScheduleStop),
    instantSchedule: Boolean(obj.instantSchedule),
    scheduleAccessMode: parseScheduleAccessMode(obj.scheduleAccessMode),
  };
}

export function isAdminRole(role: string): boolean {
  return role === 'admin';
}

export function normalizeAppRole(role: string | null | undefined): 'admin' | 'analyst' | 'viewer' {
  if (role === 'admin' || role === 'analyst' || role === 'viewer') return role;
  return 'viewer';
}

export function resolveUserPermissions(
  role: string,
  permissions: unknown
): UserPermissions {
  if (isAdminRole(role)) return { ...FULL_PERMISSIONS };
  return parseUserPermissions(permissions);
}

export type UserActionPermission = Exclude<keyof UserPermissions, 'scheduleAccessMode'>;

export function hasPermission(
  role: string,
  permissions: unknown,
  key: UserActionPermission
): boolean {
  return resolveUserPermissions(role, permissions)[key];
}
