import type { NextApiResponse } from 'next';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requireSecurityTab } from '@/lib/security-permission-auth';
import { invalidateSecurityToolSettingsCache } from '@/lib/security-service';
import {
  authenticateSonarqubeWithTokenJob,
  refreshSonarqubeAuthStatus,
} from '@/lib/security/sonarqube-auth-job';
import { SONAR_TOKEN_DOCS_URL } from '@/lib/security/sonarqube-constants';
import { invalidateToolRuntimeCache } from '@/lib/security/tool-runtime';
import { z } from 'zod';

const bodySchema = z.object({
  action: z.literal('token'),
  token: z.string().min(8),
  serverUrl: z.string().min(4),
});

function setNoCacheHeaders(res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  setNoCacheHeaders(res);

  if (req.method === 'GET') {
    invalidateSecurityToolSettingsCache();
    invalidateToolRuntimeCache('sonarqube');
    const status = await refreshSonarqubeAuthStatus();
    return res.status(200).json({
      ...status,
      tokenDocsUrl: SONAR_TOKEN_DOCS_URL,
    });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  invalidateSecurityToolSettingsCache();
  invalidateToolRuntimeCache('sonarqube');

  const status = await authenticateSonarqubeWithTokenJob(
    parsed.data.serverUrl,
    parsed.data.token
  );
  return res.status(status.authenticated ? 200 : 400).json({
    ...status,
    tokenDocsUrl: SONAR_TOKEN_DOCS_URL,
  });
}

export default requireSecurityTab('securityTools')(handler);
