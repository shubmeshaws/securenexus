import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import argocdClient, { getCachedArgoApps } from '@/lib/argocd-client';
import { getEnvironmentHours } from '@/lib/environment-metrics';
import { sortSchedulesForDashboard } from '@/lib/schedule-dashboard';

const OVERVIEW_CACHE_TTL_MS = 180_000;

type OverviewPayload = Awaited<ReturnType<typeof buildOverviewPayload>>;

let overviewCache: { data: OverviewPayload; at: number } | null = null;

async function buildOverviewPayload() {
  const allSchedulesPromise = prisma.schedule.findMany({ where: { enabled: true } });

  const [allSchedules, registeredClusters, environment, argocdResult] = await Promise.all([
    allSchedulesPromise,
    prisma.cluster.count({ where: { status: 'connected' } }).catch(() => 0),
    getEnvironmentHours(),
    argocdClient.listApplications().then(
      (apps) => ({ reachable: true as const, apps }),
      (err) => {
        const cached = getCachedArgoApps();
        if (cached?.length) {
          return {
            reachable: true as const,
            apps: cached,
            stale: true as const,
          };
        }
        return {
          reachable: false as const,
          apps: [] as Awaited<ReturnType<typeof argocdClient.listApplications>>,
          message: err instanceof Error ? err.message : 'ArgoCD unreachable',
        };
      }
    ),
  ]);

  const schedules = sortSchedulesForDashboard(allSchedules);
  const argocdApps = argocdResult.apps;

  return {
      summary: {
        totalApps: argocdApps.length || schedules.length,
        running: argocdApps.filter((app) => ['Healthy', 'Progressing'].includes(app.healthStatus)).length,
        stopped: Math.max(
          argocdApps.length -
            argocdApps.filter((app) => ['Healthy', 'Progressing'].includes(app.healthStatus)).length,
          0
        ),
        scheduled: allSchedules.length,
        connectedClusters: registeredClusters,
        runningHours: environment.runningHours,
        stoppedHours: environment.stoppedHours,
        environmentState: environment.state,
      },
      environment,
      activeSchedules: schedules,
      k8sDegraded: false,
      argocdDegraded: !argocdResult.reachable,
      argocdMessage: argocdResult.reachable
        ? undefined
        : 'message' in argocdResult
          ? argocdResult.message
          : 'ArgoCD unreachable',
    };
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  if (overviewCache && Date.now() - overviewCache.at < OVERVIEW_CACHE_TTL_MS) {
    return res.status(200).json(overviewCache.data);
  }

  try {
    const payload = await buildOverviewPayload();
    overviewCache = { data: payload, at: Date.now() };
    return res.status(200).json(payload);
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
      k8sDegraded: false,
      argocdDegraded: true,
      argocdMessage: err instanceof Error ? err.message : 'Failed to load dashboard overview',
    });
  }
}

export default requireAuth(handler);
