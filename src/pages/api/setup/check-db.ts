import type { NextApiRequest, NextApiResponse } from 'next';
import { checkDatabaseConnection } from '@/lib/setup';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const result = await checkDatabaseConnection();
  return res.status(result.ok ? 200 : 503).json(result);
}
