import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  getActiveSecurityScanJob,
  rerunSecurityScanJob,
} from '@/lib/security-scan-job-service';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'Missing scan job id' });
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const active = await getActiveSecurityScanJob();
    if (active) {
      return res.status(409).json({
        error: 'A scan is already in progress',
        job: active,
      });
    }

    const job = await rerunSecurityScanJob(id);
    return res.status(201).json({ job });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to rerun scan';
    return res.status(400).json({ error: message });
  }
}

export default requireAdmin(handler);
