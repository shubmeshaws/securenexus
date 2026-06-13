import type { NextApiResponse } from 'next';
import { getTokenFromRequest, verifyToken, type AuthenticatedRequest } from '@/lib/auth';
import { getBroadcastNotifications } from '@/lib/activity';
import { broadcastLogsToNotifications } from '@/lib/notifications';

export default async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    verifyToken(token);
    const logs = await getBroadcastNotifications();
    const notifications = broadcastLogsToNotifications(logs);
    const unread = notifications.length;
    return res.status(200).json({ notifications, unread });
  } catch {
    return res.status(401).json({ error: 'Invalid session' });
  }
}
