import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureDatabaseSchema } from '@/lib/setup';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const result = await ensureDatabaseSchema();
  return res.status(result.ok ? 200 : 500).json(result);
}
