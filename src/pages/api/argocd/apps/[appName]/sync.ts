import type { NextApiResponse } from 'next';
import { requireAuth, requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import argocdClient from '@/lib/argocd-client';
import { syncPolicySchema } from '@/lib/validation';
import { logActivityFromRequest } from '@/lib/activity';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { appName } = req.query;
  const instanceId = typeof req.query.instanceId === 'string' ? req.query.instanceId : undefined;
  if (typeof appName !== 'string') {
    return res.status(400).json({ error: 'appName is required' });
  }

  if (req.method !== 'PATCH') return methodNotAllowed(res, ['PATCH']);

  const parsed = syncPolicySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    await argocdClient.updateSyncPolicy(appName, parsed.data.syncPolicy, instanceId);

    const app = await argocdClient.getApplication(appName, instanceId);
    await logActivityFromRequest(req, {
      action: parsed.data.syncPolicy === 'automated' ? 'sync-on' : 'sync-off',
      cluster: app.cluster,
      namespace: app.destinationNamespace,
      appName,
      triggeredBy: req.user?.email ?? 'manual',
      status: 'success',
      message: `Sync policy set to ${parsed.data.syncPolicy}`,
    });

    return res.status(200).json({ success: true, syncPolicy: parsed.data.syncPolicy });
  } catch (err) {
    await logActivityFromRequest(req, {
      action: parsed.data.syncPolicy === 'automated' ? 'sync-on' : 'sync-off',
      cluster: 'unknown',
      namespace: 'unknown',
      appName,
      triggeredBy: req.user?.email ?? 'manual',
      status: 'failed',
      message: err instanceof Error ? err.message : 'Sync policy update failed',
    });
    return res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to update sync policy',
    });
  }
}

export default requireAdmin(handler);
