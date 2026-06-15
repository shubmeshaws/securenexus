import type { LucideIcon } from 'lucide-react';
import { PAGE_META } from '@/lib/page-meta';
import {
  Boxes,
  CalendarRange,
  Cpu,
  ScrollText,
  UserRound,
} from '@/lib/icons';

export type SearchResultCategory = 'page' | 'cluster' | 'schedule' | 'activity' | 'user' | 'infrastructure';

export interface SearchResult {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  category: SearchResultCategory;
  icon: LucideIcon;
  keywords: string;
}

export const PAGE_SEARCH_ITEMS: SearchResult[] = [
  { id: 'page-dashboard', title: 'Dashboard', subtitle: 'Overview & metrics', href: '/dashboard', category: 'page', icon: PAGE_META['/dashboard'].icon, keywords: 'dashboard overview metrics apps' },
  { id: 'page-infra', title: 'Infrastructure', subtitle: 'Start / stop EKS workloads', href: '/infrastructure', category: 'page', icon: PAGE_META['/infrastructure'].icon, keywords: 'infrastructure eks start stop' },
  { id: 'page-clusters', title: 'Clusters', subtitle: 'Manage cluster registry', href: '/clusters', category: 'page', icon: PAGE_META['/clusters'].icon, keywords: 'clusters kubeconfig aws eks registry' },
  { id: 'page-schedules', title: 'Schedules', subtitle: 'Auto start/stop windows', href: '/schedules', category: 'page', icon: PAGE_META['/schedules'].icon, keywords: 'schedules cron shutdown startup' },
  { id: 'page-live-schedules', title: 'Live Schedules', subtitle: 'Executing & active now', href: '/active-schedules', category: 'page', icon: PAGE_META['/active-schedules'].icon, keywords: 'live active executing running schedule window' },
  { id: 'page-resource-audit', title: 'Resource changes', subtitle: 'CPU memory replica changes', href: '/resource-audit', category: 'page', icon: PAGE_META['/resource-audit'].icon, keywords: 'resource audit cpu memory replicas argocd author commit' },
  { id: 'page-activity', title: 'Activity Logs', subtitle: 'Audit trail', href: '/activity', category: 'page', icon: PAGE_META['/activity'].icon, keywords: 'activity logs audit history' },
  { id: 'page-alerts', title: 'Alerts', subtitle: 'Email, Teams & in-app notifications', href: '/alerts', category: 'page', icon: PAGE_META['/alerts'].icon, keywords: 'alerts notifications email teams webhook' },
  { id: 'page-admin', title: 'Admin Panel', subtitle: 'Users & roles', href: '/admin', category: 'page', icon: PAGE_META['/admin'].icon, keywords: 'admin users roles permissions' },
];

export function filterSearchResults(items: SearchResult[], query: string): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, 12);

  return items
    .filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        item.keywords.toLowerCase().includes(q) ||
        item.category.includes(q)
    )
    .slice(0, 12);
}

export function buildDynamicSearchResults(data: {
  clusters?: { id: string; name: string; provider: string; status: string }[];
  schedules?: { id: string; name: string; cluster: string; appName: string }[];
  activity?: { id: string; action: string; cluster: string; appName: string; triggeredBy: string }[];
  users?: { id: string; displayName: string; email: string; role: string }[];
  infraClusters?: { id: string; name: string; infraState: string }[];
}): SearchResult[] {
  const results: SearchResult[] = [];

  data.clusters?.forEach((c) => {
    results.push({
      id: `cluster-${c.id}`,
      title: c.name,
      subtitle: `${c.provider} cluster · ${c.status}`,
      href: '/clusters',
      category: 'cluster',
      icon: Boxes,
      keywords: `${c.name} cluster ${c.provider} ${c.status}`,
    });
  });

  data.schedules?.forEach((s) => {
    results.push({
      id: `schedule-${s.id}`,
      title: s.name,
      subtitle: `${s.cluster} / ${s.appName}`,
      href: '/schedules',
      category: 'schedule',
      icon: CalendarRange,
      keywords: `${s.name} schedule ${s.cluster} ${s.appName}`,
    });
  });

  data.infraClusters?.forEach((c) => {
    results.push({
      id: `infra-${c.id}`,
      title: c.name,
      subtitle: `Infrastructure · ${c.infraState}`,
      href: '/infrastructure',
      category: 'infrastructure',
      icon: Cpu,
      keywords: `${c.name} infrastructure ${c.infraState}`,
    });
  });

  data.activity?.forEach((a) => {
    results.push({
      id: `activity-${a.id}`,
      title: `${a.action} — ${a.appName}`,
      subtitle: `${a.cluster} · by ${a.triggeredBy}`,
      href: '/activity',
      category: 'activity',
      icon: ScrollText,
      keywords: `${a.action} ${a.cluster} ${a.appName} activity`,
    });
  });

  data.users?.forEach((u) => {
    results.push({
      id: `user-${u.id}`,
      title: u.displayName,
      subtitle: `${u.email} · ${u.role}`,
      href: '/admin',
      category: 'user',
      icon: UserRound,
      keywords: `${u.displayName} ${u.email} user admin`,
    });
  });

  return results;
}

export function categoryLabel(cat: SearchResultCategory): string {
  const labels: Record<SearchResultCategory, string> = {
    page: 'Page',
    cluster: 'Cluster',
    schedule: 'Schedule',
    activity: 'Activity',
    user: 'User',
    infrastructure: 'Infrastructure',
  };
  return labels[cat];
}
