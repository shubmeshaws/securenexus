/** React Query key prefixes to refetch when refreshing a dashboard page. */
export const PAGE_REFRESH_QUERY_KEYS: Record<string, readonly (readonly string[])[]> = {
  '/dashboard': [
    ['overview'],
    ['dashboard-insights'],
    ['node-count-trend'],
    ['schedule-actions'],
  ],
  '/infrastructure': [
    ['infrastructure'],
    ['clusters'],
    ['argocd-apps'],
    ['deployments'],
    ['namespaces'],
  ],
  '/clusters': [['registered-clusters'], ['clusters']],
  '/schedules': [['schedules'], ['schedules-live']],
  '/active-schedules': [['schedules-live'], ['schedules']],
  '/resource-audit': [['resource-audit'], ['resource-audit-summary']],
  '/activity': [['activity']],
  '/alerts': [['alert-settings'], ['notifications']],
  '/admin': [
    ['admin-users'],
    ['admin-settings'],
    ['aws-credentials'],
    ['aws-settings'],
    ['argocd-instances'],
    ['bitbucket-connection'],
    ['bitbucket-repositories'],
    ['bitbucket-app-sources'],
    ['admin-devops-contacts'],
  ],
  '/contact': [['devops-contacts']],
};

export function getPageRefreshQueryKeys(pathname: string | null): readonly (readonly string[])[] {
  if (!pathname) return [];

  const match = Object.entries(PAGE_REFRESH_QUERY_KEYS).find(([path]) =>
    path === '/dashboard' ? pathname === path : pathname.startsWith(path)
  );

  return match?.[1] ?? [];
}

export function queryMatchesRefreshKeys(
  queryKey: readonly unknown[],
  refreshKeys: readonly (readonly string[])[],
): boolean {
  return refreshKeys.some((prefix) =>
    prefix.every((part, index) => queryKey[index] === part)
  );
}
