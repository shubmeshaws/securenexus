import type { SecurityTabPermission } from '@/lib/user-permissions';

export type SecuritySectionId =
  | 'dashboard'
  | 'resources'
  | 'tools'
  | 'scan'
  | 'automation'
  | 'reports';

export const SECURITY_SECTIONS: { id: SecuritySectionId; label: string; permission: SecurityTabPermission }[] = [
  { id: 'dashboard', label: 'Dashboard', permission: 'securityDashboard' },
  { id: 'resources', label: 'Add Resource', permission: 'securityResources' },
  { id: 'tools', label: 'Tools', permission: 'securityTools' },
  { id: 'scan', label: 'Scan', permission: 'securityScan' },
  { id: 'automation', label: 'Automation', permission: 'securityAutomation' },
  { id: 'reports', label: 'Reports', permission: 'securityReports' },
];

export const SECURITY_SECTION_PERMISSION: Record<SecuritySectionId, SecurityTabPermission> =
  Object.fromEntries(SECURITY_SECTIONS.map((row) => [row.id, row.permission])) as Record<
    SecuritySectionId,
    SecurityTabPermission
  >;
