import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { deleteDevOpsContact, updateDevOpsContact } from '@/lib/devops-contacts';
import { z } from 'zod';

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  designation: z.string().max(120).optional(),
  email: z.string().max(254).optional(),
  phone: z.string().max(40).optional(),
  imageUrl: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const { id } = req.query;
  if (typeof id !== 'string') return res.status(400).json({ error: 'id is required' });

  if (req.method === 'PUT') {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const contact = await updateDevOpsContact(id, parsed.data);
      return res.status(200).json({ contact });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update contact';
      const status = message === 'Contact not found' ? 404 : 400;
      return res.status(status).json({ error: message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await deleteDevOpsContact(id);
      return res.status(200).json({ success: true });
    } catch {
      return res.status(404).json({ error: 'Contact not found' });
    }
  }

  return methodNotAllowed(res, ['PUT', 'DELETE']);
}

export default requireAdmin(handler);
