import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { listNamespaces } from '@/lib/k8s-client';
import { parseClusterDisplay } from '@/lib/utils';
import { resolveAwsCredentialForAccount } from '@/lib/eks-kubeconfig';

const TEST_TIMEOUT_MS = 12_000;

class TimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`Timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { cluster } = req.query;
  if (typeof cluster !== 'string') {
    return res.status(400).json({ error: 'cluster is required' });
  }

  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const startedAt = Date.now();
  try {
    const namespaces = await withTimeout(listNamespaces(cluster), TEST_TIMEOUT_MS);
    return res.status(200).json({
      ok: true,
      namespaceCount: namespaces.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const baseMessage = err instanceof Error ? err.message : 'Connection failed';

    const { accountId } = parseClusterDisplay(cluster);
    const hasAwsCred = accountId
      ? Boolean(await resolveAwsCredentialForAccount(accountId).catch(() => null))
      : false;

    const hint =
      err instanceof TimeoutError
        ? 'The cluster API did not respond in time. Check VPN/network reachability to the cluster endpoint (private endpoints require being inside the VPC/VPN), or EKS token generation may be slow.'
        : accountId && !hasAwsCred
          ? `No AWS Integration credential found for account ${accountId}. Add it under Admin → Settings → AWS Integration, or configure kubeconfig auth on the server.`
          : 'Verify the cluster credentials and that the server can reach the cluster API.';

    return res.status(200).json({
      ok: false,
      durationMs,
      error: baseMessage,
      hint,
    });
  }
}

export default requireAuth(handler);
