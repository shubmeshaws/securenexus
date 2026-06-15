import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { generateSecureNexusIamPolicy } from '@/lib/aws-settings';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const result = await generateSecureNexusIamPolicy();
  return res.status(200).json(result);
}

export default requireAdmin(handler);
