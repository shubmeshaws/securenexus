import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import {
  createDevOpsContact,
  getDevOpsContactsAdminView,
  setDevOpsContactsTitle,
} from '@/lib/devops-contacts';
import { z } from 'zod';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  designation: z.string().max(120).optional(),
  email: z.string().max(254).optional(),
  phone: z.string().max(40).optional(),
  imageUrl: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

const titleSchema = z.object({
  title: z.string().min(1).max(80),
});

async function getHandler(_req: AuthenticatedRequest, res: NextApiResponse) {
  const data = await getDevOpsContactsAdminView();
  return res.status(200).json(data);
}

async function postHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const contact = await createDevOpsContact(parsed.data);
    return res.status(201).json({ contact });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create contact';
    return res.status(400).json({ error: message });
  }
}

async function putHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const parsed = titleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const title = await setDevOpsContactsTitle(parsed.data.title);
    return res.status(200).json({ title });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update title';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return postHandler(req, res);
  if (req.method === 'PUT') return putHandler(req, res);
  return methodNotAllowed(res, ['GET', 'POST', 'PUT']);
}

export default requireAdmin(handler);
