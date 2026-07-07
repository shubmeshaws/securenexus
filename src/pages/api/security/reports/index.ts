import type { NextApiResponse } from 'next';
import { methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requireSecurityTab } from '@/lib/security-permission-auth';
import { generateSecurityReport, listSecurityReports } from '@/lib/security-service';
import { z } from 'zod';

const generateSchema = z.object({
  resourceId: z.string().min(1),
  toolId: z.string().min(1),
});

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    const reports = await listSecurityReports();
    return res.status(200).json({ reports });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load reports';
    return res.status(500).json({ error: message });
  }
}

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const report = await generateSecurityReport(parsed.data);
    return res.status(201).json({ report });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate report';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return postHandler(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

export default requireSecurityTab('securityReports')(handler);
