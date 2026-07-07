import type { NextApiResponse } from 'next';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requireSecurityTab } from '@/lib/security-permission-auth';
import { invalidateSecurityToolSettingsCache } from '@/lib/security-service';
import { SNYK_AUTH_URL, isSnykAuthenticated } from '@/lib/security/snyk-runner';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  invalidateSecurityToolSettingsCache();
  const authenticated = await isSnykAuthenticated();

  return res.status(200).json({
    authenticated,
    authUrl: authenticated ? null : SNYK_AUTH_URL,
  });
}

export default requireSecurityTab('securityTools')(handler);
