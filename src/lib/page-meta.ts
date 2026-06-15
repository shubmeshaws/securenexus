import type { LucideIcon } from 'lucide-react';
import { Icons } from '@/lib/icons';

export interface PageMeta {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  gradient: string;
  ring: string;
  iconClass: string;
  accent: 'blue' | 'emerald' | 'amber' | 'red' | 'sky' | 'violet' | 'slate';
}

export const PAGE_META: Record<string, PageMeta> = {
  '/dashboard': {
    title: 'Dashboard',
    subtitle: 'Overview & live metrics',
    icon: Icons.pages.dashboard,
    gradient: 'from-blue-500 via-blue-600 to-indigo-600',
    ring: 'ring-blue-500/25',
    iconClass: 'text-blue-700',
    accent: 'blue',
  },
  '/infrastructure': {
    title: 'Infrastructure',
    subtitle: 'Workload control plane',
    icon: Icons.pages.infrastructure,
    gradient: 'from-violet-500 via-purple-600 to-fuchsia-600',
    ring: 'ring-violet-500/25',
    iconClass: 'text-violet-700',
    accent: 'violet',
  },
  '/clusters': {
    title: 'Clusters',
    subtitle: 'Registry & explorer',
    icon: Icons.pages.clusters,
    gradient: 'from-sky-500 via-cyan-600 to-teal-600',
    ring: 'ring-sky-500/25',
    iconClass: 'text-sky-700',
    accent: 'sky',
  },
  '/schedules': {
    title: 'Schedules',
    subtitle: 'Automated windows',
    icon: Icons.pages.schedules,
    gradient: 'from-amber-500 via-orange-500 to-rose-500',
    ring: 'ring-amber-500/25',
    iconClass: 'text-amber-700',
    accent: 'amber',
  },
  '/active-schedules': {
    title: 'Live Schedules',
    subtitle: 'Stopped window (shutdown → startup)',
    icon: Icons.pages.liveSchedules,
    gradient: 'from-lime-500 via-emerald-500 to-teal-600',
    ring: 'ring-emerald-500/25',
    iconClass: 'text-emerald-700',
    accent: 'emerald',
  },
  '/resource-audit': {
    title: 'Resource changes',
    subtitle: 'Pod resource & replica changes via ArgoCD',
    icon: Icons.pages.resourceAudit,
    gradient: 'from-orange-500 via-amber-500 to-yellow-600',
    ring: 'ring-orange-500/25',
    iconClass: 'text-orange-700',
    accent: 'amber',
  },
  '/activity': {
    title: 'Activity Logs',
    subtitle: 'Audit & compliance trail',
    icon: Icons.pages.activity,
    gradient: 'from-emerald-500 via-teal-600 to-green-600',
    ring: 'ring-emerald-500/25',
    iconClass: 'text-emerald-700',
    accent: 'emerald',
  },
  '/alerts': {
    title: 'Alerts',
    subtitle: 'In-app, email & Teams',
    icon: Icons.pages.alerts,
    gradient: 'from-rose-500 via-pink-600 to-fuchsia-600',
    ring: 'ring-rose-500/25',
    iconClass: 'text-rose-700',
    accent: 'red',
  },
  '/admin': {
    title: 'Admin Panel',
    subtitle: 'Users & platform settings',
    icon: Icons.pages.admin,
    gradient: 'from-slate-600 via-zinc-700 to-slate-800',
    ring: 'ring-slate-500/25',
    iconClass: 'text-slate-700',
    accent: 'slate',
  },
};

const FALLBACK_META: PageMeta = {
  title: 'SecureNexus',
  subtitle: 'Infrastructure orchestration',
  icon: Icons.pages.dashboard,
  gradient: 'from-blue-500 to-indigo-600',
  ring: 'ring-blue-500/25',
  iconClass: 'text-blue-700',
  accent: 'blue',
};

export function getPageMeta(pathname: string | null): PageMeta {
  if (!pathname) return FALLBACK_META;

  const match = Object.entries(PAGE_META).find(([path]) =>
    path === '/dashboard' ? pathname === path : pathname.startsWith(path)
  );

  return match?.[1] ?? FALLBACK_META;
}
