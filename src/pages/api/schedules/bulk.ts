import type { NextApiResponse } from 'next';
import { requireAuth, requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listClusters, listNamespaces, listDeployments, scaleDeployment } from '@/lib/k8s-client';
import argocdClient from '@/lib/argocd-client';
import { logActivityFromRequest } from '@/lib/activity';
import { setEnvironmentState } from '@/lib/environment-metrics';
import { invalidateWorkloadCache } from '@/lib/workload-scan';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const action = req.body?.action as 'stop-all' | 'start-all';
  if (action !== 'stop-all' && action !== 'start-all') {
    return res.status(400).json({ error: 'action must be stop-all or start-all' });
  }

  const defaultReplicas = Number(req.body?.defaultReplicas ?? 1);
  const results: { cluster: string; namespace: string; app: string; status: string }[] = [];

  try {
    const clusters = await listClusters();
    for (const cluster of clusters) {
      let namespaces: string[] = [];
      try {
        namespaces = await listNamespaces(cluster.name);
      } catch {
        continue;
      }

      for (const ns of namespaces) {
        let deployments;
        try {
          deployments = await listDeployments(cluster.name, ns);
        } catch {
          continue;
        }

        for (const dep of deployments) {
          try {
            const replicas = action === 'stop-all' ? 0 : defaultReplicas;
            await scaleDeployment(cluster.name, ns, dep.name, replicas);

            if (action === 'stop-all') {
              try {
                await argocdClient.updateSyncPolicy(dep.name, 'none');
              } catch {
                // app may not exist in ArgoCD
              }
            }

            await logActivityFromRequest(req, {
              action: action === 'stop-all' ? 'scale-down' : 'scale-up',
              cluster: cluster.name,
              namespace: ns,
              appName: dep.name,
              triggeredBy: req.user?.email ?? 'bulk-action',
              status: 'success',
              message: `Bulk ${action}: scaled to ${replicas}`,
            });

            results.push({ cluster: cluster.name, namespace: ns, app: dep.name, status: 'success' });
          } catch (err) {
            results.push({
              cluster: cluster.name,
              namespace: ns,
              app: dep.name,
              status: err instanceof Error ? err.message : 'failed',
            });
          }
        }
      }
    }

    if (results.some((r) => r.status === 'success')) {
      await setEnvironmentState(action === 'stop-all' ? 'stopped' : 'running');
      invalidateWorkloadCache();
    }

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Bulk action failed',
      results,
    });
  }
}

export default requireAdmin(handler);
