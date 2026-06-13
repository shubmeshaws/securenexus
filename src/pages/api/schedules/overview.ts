import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import argocdClient from '@/lib/argocd-client';
import { getWorkloadSummary } from '@/lib/workload-scan';
import { getEnvironmentHours } from '@/lib/environment-metrics';
import { getDashboardInsights } from '@/lib/dashboard-metrics';
import { sortSchedulesForDashboard } from '@/lib/schedule-dashboard';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const allSchedulesPromise = prisma.schedule.findMany({ where: { enabled: true } });

    const [allSchedules, registeredClusters, workloadScan, environment, argocdResult, insights] =
      await Promise.all([
        allSchedulesPromise,
        prisma.cluster.count({ where: { status: 'connected' } }).catch(() => 0),
        getWorkloadSummary(),
        getEnvironmentHours(),
        argocdClient.listApplications().then(
          (apps) => ({ reachable: true as const, apps }),
          (err) => ({
            reachable: false as const,
            apps: [] as Awaited<ReturnType<typeof argocdClient.listApplications>>,
            message: err instanceof Error ? err.message : 'ArgoCD unreachable',
          })
        ),
        allSchedulesPromise
          .then((s) => getDashboardInsights(s))
          .catch(() => ({
            namespaceStopped: [],
            instanceTypes: [],
            costSavings: [],
            totals: {
              stoppedHours: 0,
              stoppedHoursToday: 0,
              stoppedHoursMonth: 0,
              cpuSavedTotal: 0,
              memorySavedTotal: 0,
              cpuSavedPerDay: 0,
              memorySavedPerDay: 0,
              cpuSavedPerMonth: 0,
              memorySavedPerMonth: 0,
            },
          })),
      ]);

    const schedules = sortSchedulesForDashboard(allSchedules);

    const argocdApps = argocdResult.apps;
    const argocdHasApps = argocdResult.reachable && argocdApps.length > 0;

    let running = workloadScan.running;
    let stopped = workloadScan.stopped;
    let k8sDegraded = workloadScan.k8sUnavailable;
    let k8sMessage: string | undefined;

    if (argocdHasApps) {
      running = argocdApps.filter((app) =>
        ['Healthy', 'Progressing'].includes(app.healthStatus)
      ).length;
      stopped = Math.max(argocdApps.length - running, 0);
      if (workloadScan.k8sUnavailable) {
        k8sDegraded = false;
      }
    } else if (workloadScan.k8sUnavailable) {
      k8sMessage =
        registeredClusters > 0
          ? 'Could not reach your registered cluster API. Re-add the cluster under Clusters if credentials expired.'
          : 'No cluster configured. Add one under Clusters to monitor workloads.';
    }

    const totalApps = argocdApps.length || workloadScan.totalApps || schedules.length;

    return res.status(200).json({
      summary: {
        totalApps,
        running,
        stopped,
        scheduled: allSchedules.length,
        connectedClusters: registeredClusters,
        runningHours: environment.runningHours,
        stoppedHours: environment.stoppedHours,
        environmentState: environment.state,
      },
      environment,
      activeSchedules: schedules,
      insights,
      k8sDegraded,
      k8sMessage,
      argocdDegraded: !argocdResult.reachable,
      argocdMessage: argocdResult.reachable
        ? undefined
        : 'message' in argocdResult
          ? argocdResult.message
          : 'ArgoCD unreachable',
    });
  } catch (err) {
    const environment = await getEnvironmentHours().catch(() => ({
      state: 'running' as const,
      stateSince: new Date().toISOString(),
      runningHours: 0,
      stoppedHours: 0,
    }));

    return res.status(200).json({
      summary: {
        totalApps: 0,
        running: 0,
        stopped: 0,
        scheduled: 0,
        connectedClusters: 0,
        runningHours: environment.runningHours,
        stoppedHours: environment.stoppedHours,
        environmentState: environment.state,
      },
      environment,
      activeSchedules: [],
      insights: {
        namespaceStopped: [],
        instanceTypes: [],
        costSavings: [],
        totals: {
          stoppedHours: 0,
          stoppedHoursToday: 0,
          stoppedHoursMonth: 0,
          cpuSavedTotal: 0,
          memorySavedTotal: 0,
          cpuSavedPerDay: 0,
          memorySavedPerDay: 0,
          cpuSavedPerMonth: 0,
          memorySavedPerMonth: 0,
        },
      },
      k8sDegraded: true,
      k8sMessage: err instanceof Error ? err.message : 'Failed to load dashboard overview',
      argocdDegraded: true,
      argocdMessage: err instanceof Error ? err.message : 'Failed to load dashboard overview',
    });
  }
}

export default requireAuth(handler);
