/** Tool IDs that share one Snyk CLI install + auth session on the server. */
export const SNYK_TOOL_IDS = ['snyk', 'snyk-code'] as const;
export type SnykToolId = (typeof SNYK_TOOL_IDS)[number];

export function isSnykToolId(toolId: string): toolId is SnykToolId {
  return (SNYK_TOOL_IDS as readonly string[]).includes(toolId);
}

export function resolveSnykInstallCommandsToolId(toolId: string): string {
  return isSnykToolId(toolId) ? 'snyk' : toolId;
}

interface SnykInstallRow {
  installedAt: Date | null;
  installedOs: string | null;
  enabled: boolean;
}

export function resolveSharedSnykInstall(
  byId: Map<string, SnykInstallRow | undefined>
): { installedAt: Date | null; installedOs: string | null } {
  for (const id of SNYK_TOOL_IDS) {
    const row = byId.get(id);
    if (row?.installedAt) {
      return { installedAt: row.installedAt, installedOs: row.installedOs ?? null };
    }
  }
  return { installedAt: null, installedOs: null };
}
