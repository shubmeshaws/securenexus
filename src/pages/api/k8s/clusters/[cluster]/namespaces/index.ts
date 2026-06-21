import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listNamespaces } from '@/lib/k8s-client';
import prisma from '@/lib/prisma';
import {
  getCatalogNamespacesForCluster,
  getSnapshotNamespacesForCluster,
  getArgoCDNamespacesForCluster,
} from '@/lib/resource-app-catalog';
import { parseClusterDisplay } from '@/lib/utils';
import { resolveAwsCredentialForAccount } from '@/lib/eks-kubeconfig';

const K8S_NAMESPACE_TIMEOUT_MS = 12_000;
const ARGOCD_NAMESPACE_TIMEOUT_MS = 8_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

async function getDbNamespaceHints(cluster: string): Promise<string[]> {
  const [catalogNamespaces, snapshotNamespaces, scheduleNamespaces] = await Promise.all([
    getCatalogNamespacesForCluster(cluster).catch(() => []),
    getSnapshotNamespacesForCluster(cluster).catch(() => []),
    prisma.schedule
      .findMany({
        where: { cluster: { in: [cluster, parseClusterDisplay(cluster).clusterName] } },
        distinct: ['namespace'],
        select: { namespace: true },
        orderBy: { namespace: 'asc' },
      })
      .then((rows) => rows.map((r) => r.namespace).filter(Boolean)),
  ]);

  return Array.from(
    new Set([...catalogNamespaces, ...snapshotNamespaces, ...scheduleNamespaces].filter(Boolean))
  );
}

function mergeNamespaces(...groups: string[][]): string[] {
  return Array.from(new Set(groups.flat().filter(Boolean))).sort();
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { cluster } = req.query;
  if (typeof cluster !== 'string') {
    return res.status(400).json({ error: 'cluster is required' });
  }

  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const dbNamespaces = await getDbNamespaceHints(cluster);

  const k8sNamespaces = await withTimeout(listNamespaces(cluster), K8S_NAMESPACE_TIMEOUT_MS);

  if (k8sNamespaces?.length) {
    return res.status(200).json({
      namespaces: mergeNamespaces(k8sNamespaces, dbNamespaces),
      source: 'k8s' as const,
    });
  }

  if (dbNamespaces.length > 0) {
    return res.status(200).json({
      namespaces: dbNamespaces,
      source: 'fallback' as const,
      warning:
        'Kubernetes API was slow or unavailable. Showing namespaces from schedules and audit history.',
    });
  }

  const argocdNamespaces =
    (await withTimeout(
      getArgoCDNamespacesForCluster(cluster),
      ARGOCD_NAMESPACE_TIMEOUT_MS
    )) ?? [];

  if (argocdNamespaces.length > 0) {
    return res.status(200).json({
      namespaces: mergeNamespaces(argocdNamespaces),
      source: 'fallback' as const,
      warning:
        'Kubernetes API did not allow listing namespaces. Showing namespaces inferred from ArgoCD.',
    });
  }

  const { accountId } = parseClusterDisplay(cluster);
  const hasAwsCred = accountId ? Boolean(await resolveAwsCredentialForAccount(accountId)) : false;
  const hint = accountId
    ? hasAwsCred
      ? `Could not reach EKS cluster ${cluster}. Verify the IAM role can access this cluster and aws CLI is installed on the server.`
      : `No AWS Integration credential found for account ${accountId}. Add that AWS account under Admin → Settings → AWS Integration, or configure kubeconfig auth for this account on the server.`
    : 'Verify kubeconfig credentials on the SecureNexus server can authenticate to this cluster.';

  return res.status(502).json({
    error: `Failed to list namespaces. ${hint}`,
    namespaces: [],
    source: 'error' as const,
  });
}

export default requireAuth(handler);
