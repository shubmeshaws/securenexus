import type { NextApiResponse } from 'next';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requireSecurityTab } from '@/lib/security-permission-auth';
import { cancelSecurityScanJob } from '@/lib/security-scan-job-service';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'Missing scan job id' });

  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const job = await cancelSecurityScanJob(id);
    return res.status(200).json({ job });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to stop scan';
    return res.status(400).json({ error: message });
  }
}

export default requireSecurityTab('securityScan')(handler);
