import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listNamespaces } from '@/lib/k8s-client';
import prisma from '@/lib/prisma';
import {
  getCatalogNamespacesForCluster,
  getSnapshotNamespacesForCluster,
} from '@/lib/resource-app-catalog';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { cluster } = req.query;
  if (typeof cluster !== 'string') {
    return res.status(400).json({ error: 'cluster is required' });
  }

  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const namespaces = await listNamespaces(cluster);
    return res.status(200).json({ namespaces, source: 'k8s' as const });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list namespaces';

    // Common in production: kubeconfig is valid but RBAC blocks `list namespaces`.
    // Fall back to ArgoCD-derived namespaces (catalog/snapshots) so scheduling still works.
    const [catalogNamespaces, snapshotNamespaces, scheduleNamespaces] = await Promise.all([
      getCatalogNamespacesForCluster(cluster).catch(() => []),
      getSnapshotNamespacesForCluster(cluster).catch(() => []),
      prisma.schedule
        .findMany({
          where: { cluster },
          distinct: ['namespace'],
          select: { namespace: true },
          orderBy: { namespace: 'asc' },
        })
        .then((rows) => rows.map((r) => r.namespace).filter(Boolean)),
    ]);

    const namespaces = Array.from(
      new Set([...catalogNamespaces, ...snapshotNamespaces, ...scheduleNamespaces].filter(Boolean))
    ).sort();

    if (namespaces.length > 0) {
      return res.status(200).json({
        namespaces,
        source: 'fallback' as const,
        warning:
          'Kubernetes API did not allow listing namespaces. Showing namespaces inferred from ArgoCD / audit history.',
        error: message,
      });
    }

    return res.status(502).json({ error: message, namespaces: [], source: 'error' as const });
  }
}

export default requireAuth(handler);
