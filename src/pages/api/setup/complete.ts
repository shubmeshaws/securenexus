import type { NextApiRequest, NextApiResponse } from 'next';
import { getSetupStatus, markSetupComplete } from '@/lib/setup';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const status = await getSetupStatus();
  if (!status.dbConnected) {
    return res.status(503).json({ ok: false, message: 'Database is not connected.' });
  }
  if (!status.schemaExists) {
    return res.status(400).json({ ok: false, message: 'Database schema does not exist yet.' });
  }

  await markSetupComplete();
  return res.status(200).json({ ok: true, message: 'Setup complete. Redirecting to login…' });
}
