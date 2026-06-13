import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getAdminSettings, updateAdminSettings } from '@/lib/settings';
import { invalidateKubeConfigCache } from '@/lib/k8s-client';
import { invalidateWorkloadCache } from '@/lib/workload-scan';
import { z } from 'zod';

const updateSchema = z.object({
  argocdServer: z.string().optional(),
  argocdToken: z.string().optional(),
  argocdInsecureTls: z.boolean().optional(),
  kubeconfigBase64: z.string().optional(),
  googleAllowedDomain: z.string().optional(),
  demoMode: z.boolean().optional(),
  redisUrl: z.string().optional(),
  apiBaseUrl: z.string().optional(),
  activityLogRetentionDays: z.number().int().min(1).max(3650).optional(),
});

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const settings = await getAdminSettings();
  return res.status(200).json({ settings });
}

async function putHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const settings = await updateAdminSettings(parsed.data, req.user?.email);
  invalidateKubeConfigCache();
  invalidateWorkloadCache();
  return res.status(200).json({ settings });
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'PUT') return putHandler(req, res);
  return methodNotAllowed(res, ['GET', 'PUT']);
}

export default requireAdmin(handler);
