import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  getSecurityResourceSyncJob,
  startSecurityResourceSyncJob,
} from '@/lib/security-service';

function setNoCacheHeaders(res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

function jobForResource(id: string) {
  const job = getSecurityResourceSyncJob();
  if (job.resourceId !== id || job.action !== 'pull') {
    return {
      running: false,
      resourceId: null,
      action: null,
      phase: null,
      startedAt: null,
      finishedAt: null,
      result: null,
      message: null,
      error: null,
    };
  }
  return job;
}

async function getHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'Missing resource id' });
  setNoCacheHeaders(res);
  return res.status(200).json(jobForResource(id));
}

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'Missing resource id' });

  const current = getSecurityResourceSyncJob();
  if (current.running) {
    if (current.resourceId === id && current.action === 'pull') {
      setNoCacheHeaders(res);
      return res.status(200).json(current);
    }
    return res.status(409).json({
      error: `Another ${current.action ?? 'sync'} is already running for a different resource.`,
    });
  }

  const started = startSecurityResourceSyncJob(id, 'pull');
  if (!started) {
    return res.status(409).json({ error: 'Pull is already running.' });
  }

  setNoCacheHeaders(res);
  return res.status(202).json(getSecurityResourceSyncJob());
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return postHandler(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

export default requireAdmin(handler);
