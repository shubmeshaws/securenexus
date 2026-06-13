import type { NextApiResponse } from 'next';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getActivityLogs } from '@/lib/activity';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const limit = parseInt(String(req.query.limit ?? '100'), 10);
  const logs = await getActivityLogs(Math.min(limit, 500));
  return res.status(200).json({
    logs: logs.map((log) => ({
      ...log,
      timestamp: log.timestamp.toISOString(),
    })),
  });
}

export default requireAuth(handler);
