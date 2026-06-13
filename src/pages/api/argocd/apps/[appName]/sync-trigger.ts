import type { NextApiResponse } from 'next';
import { requireAuth, requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import argocdClient from '@/lib/argocd-client';
import { logActivityFromRequest } from '@/lib/activity';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { appName } = req.query;
  const instanceId = typeof req.query.instanceId === 'string' ? req.query.instanceId : undefined;
  if (typeof appName !== 'string') {
    return res.status(400).json({ error: 'appName is required' });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    await argocdClient.triggerSync(appName, instanceId);
    const app = await argocdClient.getApplication(appName, instanceId);

    await logActivityFromRequest(req, {
      action: 'sync-on',
      cluster: app.cluster,
      namespace: app.destinationNamespace,
      appName,
      triggeredBy: req.user?.email ?? 'manual',
      status: 'success',
      message: 'Manual sync triggered',
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    await logActivityFromRequest(req, {
      action: 'sync-on',
      cluster: 'unknown',
      namespace: 'unknown',
      appName,
      triggeredBy: req.user?.email ?? 'manual',
      status: 'failed',
      message: err instanceof Error ? err.message : 'Sync trigger failed',
    });
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to trigger sync',
    });
  }
}

export default requireAdmin(handler);
