export interface UserPermissions {
  scheduleEdit: boolean;
  scheduleStart: boolean;
  scheduleStop: boolean;
  liveScheduleStop: boolean;
}

export const EMPTY_PERMISSIONS: UserPermissions = {
  scheduleEdit: false,
  scheduleStart: false,
  scheduleStop: false,
  liveScheduleStop: false,
};

export const FULL_PERMISSIONS: UserPermissions = {
  scheduleEdit: true,
  scheduleStart: true,
  scheduleStop: true,
  liveScheduleStop: true,
};

/** Default permissions for new Google SSO users (viewer role). */
export const DEFAULT_NEW_USER_PERMISSIONS: UserPermissions = {
  scheduleEdit: false,
  scheduleStart: false,
  scheduleStop: false,
  liveScheduleStop: true,
};

export const PERMISSION_LABELS: Record<keyof UserPermissions, string> = {
  scheduleEdit: 'Schedule — Edit',
  scheduleStart: 'Schedule — Start',
  scheduleStop: 'Schedule — Stop',
  liveScheduleStop: 'Live Schedule — Stop',
};

export function parseUserPermissions(raw: unknown): UserPermissions {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PERMISSIONS };
  const obj = raw as Record<string, unknown>;
  return {
    scheduleEdit: Boolean(obj.scheduleEdit),
    scheduleStart: Boolean(obj.scheduleStart),
    scheduleStop: Boolean(obj.scheduleStop),
    liveScheduleStop: Boolean(obj.liveScheduleStop),
  };
}

export function isAdminRole(role: string): boolean {
  return role === 'admin';
}

export function resolveUserPermissions(
  role: string,
  permissions: unknown
): UserPermissions {
  if (isAdminRole(role)) return { ...FULL_PERMISSIONS };
  return parseUserPermissions(permissions);
}

export function hasPermission(
  role: string,
  permissions: unknown,
  key: keyof UserPermissions
): boolean {
  return resolveUserPermissions(role, permissions)[key];
}
