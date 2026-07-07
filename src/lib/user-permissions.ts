export type ScheduleAccessMode = 'all' | 'selected';

export type SecurityTabPermission =
  | 'securityDashboard'
  | 'securityResources'
  | 'securityTools'
  | 'securityScan'
  | 'securityAutomation'
  | 'securityReports';

export interface UserPermissions {
  scheduleEdit: boolean;
  scheduleStart: boolean;
  scheduleStop: boolean;
  liveScheduleStop: boolean;
  instantSchedule: boolean;
  /** When "selected", user may only view/act on schedules in their grant list. */
  scheduleAccessMode: ScheduleAccessMode;
  securityEnabled: boolean;
  securityDashboard: boolean;
  securityResources: boolean;
  securityTools: boolean;
  securityScan: boolean;
  securityAutomation: boolean;
  securityReports: boolean;
}

export const EMPTY_PERMISSIONS: UserPermissions = {
  scheduleEdit: false,
  scheduleStart: false,
  scheduleStop: false,
  liveScheduleStop: false,
  instantSchedule: false,
  scheduleAccessMode: 'all',
  securityEnabled: false,
  securityDashboard: false,
  securityResources: false,
  securityTools: false,
  securityScan: false,
  securityAutomation: false,
  securityReports: false,
};

export const FULL_PERMISSIONS: UserPermissions = {
  scheduleEdit: true,
  scheduleStart: true,
  scheduleStop: true,
  liveScheduleStop: true,
  instantSchedule: true,
  scheduleAccessMode: 'all',
  securityEnabled: true,
  securityDashboard: true,
  securityResources: true,
  securityTools: true,
  securityScan: true,
  securityAutomation: true,
  securityReports: true,
};

/** Default permissions for new Google SSO users (viewer role). */
export const DEFAULT_NEW_USER_PERMISSIONS: UserPermissions = {
  scheduleEdit: false,
  scheduleStart: false,
  scheduleStop: false,
  liveScheduleStop: true,
  instantSchedule: false,
  scheduleAccessMode: 'all',
  securityEnabled: false,
  securityDashboard: false,
  securityResources: false,
  securityTools: false,
  securityScan: false,
  securityAutomation: false,
  securityReports: false,
};

const SCHEDULE_PERMISSION_LABELS: Record<
  Exclude<keyof UserPermissions, SecurityTabPermission | 'securityEnabled'>,
  string
> = {
  scheduleEdit: 'Schedule — Edit',
  scheduleStart: 'Schedule — Start',
  scheduleStop: 'Schedule — Stop',
  liveScheduleStop: 'Live Schedule — Stop',
  instantSchedule: 'Instant Schedule',
  scheduleAccessMode: 'Schedule access scope',
};

export const SECURITY_PERMISSION_LABELS: Record<SecurityTabPermission, string> = {
  securityDashboard: 'Security — Dashboard',
  securityResources: 'Security — Add Resource',
  securityTools: 'Security — Tools',
  securityScan: 'Security — Scan',
  securityAutomation: 'Security — Automation',
  securityReports: 'Security — Reports',
};

export const PERMISSION_LABELS = {
  ...SCHEDULE_PERMISSION_LABELS,
  securityEnabled: 'Security module access',
  ...SECURITY_PERMISSION_LABELS,
} as const;

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
    securityEnabled: Boolean(obj.securityEnabled),
    securityDashboard: Boolean(obj.securityDashboard),
    securityResources: Boolean(obj.securityResources),
    securityTools: Boolean(obj.securityTools),
    securityScan: Boolean(obj.securityScan),
    securityAutomation: Boolean(obj.securityAutomation),
    securityReports: Boolean(obj.securityReports),
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

export type UserActionPermission = Exclude<
  keyof UserPermissions,
  'scheduleAccessMode' | SecurityTabPermission | 'securityEnabled'
>;

export function hasPermission(
  role: string,
  permissions: unknown,
  key: UserActionPermission
): boolean {
  return resolveUserPermissions(role, permissions)[key];
}

export function hasSecurityAccess(role: string, permissions: unknown): boolean {
  if (isAdminRole(role)) return true;
  const parsed = parseUserPermissions(permissions);
  if (!parsed.securityEnabled) return false;
  return (
    parsed.securityDashboard ||
    parsed.securityResources ||
    parsed.securityTools ||
    parsed.securityScan ||
    parsed.securityAutomation ||
    parsed.securityReports
  );
}

export function hasSecurityTabAccess(
  role: string,
  permissions: unknown,
  tab: SecurityTabPermission
): boolean {
  if (isAdminRole(role)) return true;
  const parsed = parseUserPermissions(permissions);
  return parsed.securityEnabled && parsed[tab];
}
