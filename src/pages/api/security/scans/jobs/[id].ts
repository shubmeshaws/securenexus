import type { NextApiResponse } from 'next';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requireSecurityTab } from '@/lib/security-permission-auth';
import { deleteSecurityScanJob, getSecurityScanJob } from '@/lib/security-scan-job-service';

async function getHandler(req: AuthenticatedRequest, res: NextApiResponse, id: string) {
  try {
    const job = await getSecurityScanJob(id);
    if (!job) return res.status(404).json({ error: 'Scan job not found' });
    return res.status(200).json({ job });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load scan job';
    return res.status(500).json({ error: message });
  }
}

async function deleteHandler(req: AuthenticatedRequest, res: NextApiResponse, id: string) {
  try {
    await deleteSecurityScanJob(id);
    return res.status(204).end();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete scan job';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'Missing scan job id' });

  if (req.method === 'GET') return getHandler(req, res, id);
  if (req.method === 'DELETE') return deleteHandler(req, res, id);
  return methodNotAllowed(res, ['GET', 'DELETE']);
}

export default requireSecurityTab('securityScan')(handler);
