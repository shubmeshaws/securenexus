import type { NextApiRequest, NextApiResponse } from 'next';
import { SETTING_KEYS, getSetting, isDemoModeServer } from '@/lib/settings';
import { isGoogleAuthConfigured } from '@/lib/google-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const [demoMode, apiBaseUrl] = await Promise.all([
    isDemoModeServer(),
    getSetting(SETTING_KEYS.API_BASE_URL),
  ]);

  return res.status(200).json({
    demoMode,
    apiBaseUrl: apiBaseUrl ?? '',
    googleAuthConfigured: isGoogleAuthConfigured(),
  });
}
