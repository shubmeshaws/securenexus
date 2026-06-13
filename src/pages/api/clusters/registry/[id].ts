import type { NextApiResponse } from 'next';
import { requireAuth, requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { invalidateKubeConfigCache } from '@/lib/k8s-client';
import { invalidateWorkloadCache } from '@/lib/workload-scan';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { id } = req.query;
  if (typeof id !== 'string') return res.status(400).json({ error: 'id is required' });

  if (req.method === 'DELETE') {
    const existing = await prisma.cluster.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Cluster not found' });
    await prisma.cluster.delete({ where: { id } });
    invalidateKubeConfigCache();
    invalidateWorkloadCache();
    return res.status(200).json({ success: true });
  }

  return methodNotAllowed(res, ['DELETE']);
}

export default requireAdmin(handler);
