import type { NextApiResponse } from 'next';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requireSecurityTab } from '@/lib/security-permission-auth';
import {
  createSecurityScanJob,
  getActiveSecurityScanJob,
  listSecurityScanJobs,
  startSecurityScanJobAsync,
} from '@/lib/security-scan-job-service';
import { z } from 'zod';

const runSchema = z.object({
  resourceIds: z.array(z.string().min(1)).min(1),
  toolIds: z.array(z.string().min(1)).min(1),
  reportMode: z.enum(['separate', 'merged']).optional(),
});

async function getHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    const activeOnly = req.query.active === '1' || req.query.active === 'true';
    if (activeOnly) {
      const job = await getActiveSecurityScanJob();
      return res.status(200).json({ job });
    }
    const jobs = await listSecurityScanJobs(20);
    return res.status(200).json({ jobs });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load scan jobs';
    return res.status(500).json({ error: message });
  }
}

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const active = await getActiveSecurityScanJob();
    if (active) {
      return res.status(409).json({
        error: 'A scan is already in progress',
        job: active,
      });
    }

    const job = await createSecurityScanJob({
      resourceIds: parsed.data.resourceIds,
      toolIds: parsed.data.toolIds,
      reportMode: parsed.data.reportMode,
      createdBy: req.user?.id ?? null,
    });
    startSecurityScanJobAsync(job.id);
    return res.status(201).json({ job });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start scan';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return postHandler(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

export default requireSecurityTab('securityScan')(handler);
