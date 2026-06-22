import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { requireAuth, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { requirePermission } from '@/lib/permission-auth';
import prisma from '@/lib/prisma';
import { computeNextRun, ensureSchedulerRunning } from '@/lib/scheduler';
import {
  parseSchedulesCsv,
  validateScheduleCsvRow,
  formatImportValidationError,
  type ScheduleCsvImportResult,
} from '@/lib/schedule-csv';

const importBodySchema = z.object({
  csv: z.string().min(1),
});

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const parsedBody = importBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: 'CSV content is required' });
  }

  ensureSchedulerRunning();

  const { rows } = parseSchedulesCsv(parsedBody.data.csv);
  if (rows.length === 0) {
    return res.status(400).json({ error: 'No schedule rows found in CSV' });
  }

  const result: ScheduleCsvImportResult = {
    created: 0,
    failed: 0,
    errors: [],
  };

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2;
    const row = rows[i];
    const validated = validateScheduleCsvRow(row);
    if (!validated.success) {
      result.failed++;
      result.errors.push(formatImportValidationError(row, rowNumber, validated)!);
      continue;
    }

    try {
      const data = validated.data;
      const schedule = await prisma.schedule.create({
        data: { ...data, nextRun: null },
      });
      const nextRun = computeNextRun(schedule);
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: { nextRun },
      });
      result.created++;
    } catch (err) {
      result.failed++;
      result.errors.push({
        row: rowNumber,
        name: typeof row.name === 'string' ? row.name : '',
        error: err instanceof Error ? err.message : 'Failed to create schedule',
      });
    }
  }

  return res.status(200).json(result);
}

export default requireAuth(requirePermission('scheduleEdit')(handler));
