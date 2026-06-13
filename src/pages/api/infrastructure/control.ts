import type { NextApiResponse } from 'next';
import { requireAuth, requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listClusters, listNamespaces, listDeployments, scaleDeployment } from '@/lib/k8s-client';
import argocdClient from '@/lib/argocd-client';
import { logActivityFromRequest } from '@/lib/activity';
import { setEnvironmentState } from '@/lib/environment-metrics';
import { invalidateWorkloadCache } from '@/lib/workload-scan';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const clusterName = req.body?.clusterName as string | undefined;
  const action = req.body?.action as 'start' | 'stop' | undefined;
  const defaultReplicas = Number(req.body?.defaultReplicas ?? 1);

  if (!clusterName) {
    return res.status(400).json({ error: 'clusterName is required' });
  }
  if (action !== 'start' && action !== 'stop') {
    return res.status(400).json({ error: 'action must be start or stop' });
  }

  const results: { namespace: string; app: string; status: string }[] = [];

  try {
    const clusters = (await listClusters()).filter((c) => c.name === clusterName);
    if (clusters.length === 0) {
      return res.status(404).json({ error: `Cluster "${clusterName}" not found in kubeconfig` });
    }

    const cluster = clusters[0];
    let namespaces: string[] = [];
    try {
      namespaces = await listNamespaces(cluster.name);
    } catch (err) {
      return res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to list namespaces',
      });
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
          const replicas = action === 'stop' ? 0 : defaultReplicas;
          await scaleDeployment(cluster.name, ns, dep.name, replicas);

          if (action === 'stop') {
            try {
              await argocdClient.updateSyncPolicy(dep.name, 'none');
            } catch {
              // app may not exist in ArgoCD
            }
          }

          await logActivityFromRequest(req, {
            action: action === 'stop' ? 'infra-shutdown' : 'infra-startup',
            cluster: cluster.name,
            namespace: ns,
            appName: dep.name,
            triggeredBy: req.user?.email ?? 'infra-control',
            status: 'success',
            message: `Infrastructure ${action}: scaled ${dep.name} to ${replicas}`,
          });

          results.push({ namespace: ns, app: dep.name, status: 'success' });
        } catch (err) {
          results.push({
            namespace: ns,
            app: dep.name,
            status: err instanceof Error ? err.message : 'failed',
          });
        }
      }
    }

    if (results.some((r) => r.status === 'success')) {
      await setEnvironmentState(action === 'stop' ? 'stopped' : 'running');
      invalidateWorkloadCache();
    }

    return res.status(200).json({
      success: true,
      cluster: clusterName,
      action,
      results,
      message: `Infrastructure ${action} completed for ${clusterName}`,
    });
  } catch (err) {
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Infrastructure control failed',
      results,
    });
  }
}

export default requireAdmin(handler);
