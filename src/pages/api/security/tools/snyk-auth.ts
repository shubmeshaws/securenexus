import type { NextApiResponse } from 'next';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requireSecurityTab } from '@/lib/security-permission-auth';
import { invalidateSecurityToolSettingsCache } from '@/lib/security-service';
import {
  authenticateSnykWithTokenJob,
  getSnykAuthJob,
  refreshSnykAuthStatus,
  startSnykBrowserAuthJob,
} from '@/lib/security/snyk-auth-job';
import { SNYK_TOKEN_SETTINGS_URL } from '@/lib/security/snyk-runner';
import { invalidateToolRuntimeCache } from '@/lib/security/tool-runtime';
import { z } from 'zod';

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }),
  z.object({ action: z.literal('token'), token: z.string().min(8) }),
]);

function setNoCacheHeaders(res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  setNoCacheHeaders(res);

  if (req.method === 'GET') {
    const currentJob = getSnykAuthJob();
    if (currentJob.running || currentJob.authUrl) {
      return res.status(200).json({
        ...currentJob,
        tokenSettingsUrl: SNYK_TOKEN_SETTINGS_URL,
      });
    }

    invalidateSecurityToolSettingsCache();
    invalidateToolRuntimeCache('snyk');
    const status = await refreshSnykAuthStatus();
    return res.status(200).json({
      ...status,
      tokenSettingsUrl: SNYK_TOKEN_SETTINGS_URL,
    });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  invalidateSecurityToolSettingsCache();
  invalidateToolRuntimeCache('snyk');

  if (parsed.data.action === 'start') {
    const started = startSnykBrowserAuthJob();
    if (!started) {
      return res.status(200).json(getSnykAuthJob());
    }
    return res.status(202).json(getSnykAuthJob());
  }

  const status = await authenticateSnykWithTokenJob(parsed.data.token);
  return res.status(status.authenticated ? 200 : 400).json(status);
}

export default requireSecurityTab('securityTools')(handler);
