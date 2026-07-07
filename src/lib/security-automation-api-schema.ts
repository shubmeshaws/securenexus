import { z } from 'zod';
import { AUTOMATION_SCHEDULE_FREQUENCIES } from '@/lib/security-automation-schedule';

const scheduleFrequencySchema = z.enum(
  AUTOMATION_SCHEDULE_FREQUENCIES.map((row) => row.id) as [
    'daily',
    'weekly',
    'monthly',
    'quarterly',
    'semiannual',
    'yearly',
    'once',
  ]
);

export const automationBodySchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  scheduleFrequency: scheduleFrequencySchema.optional(),
  scheduleTime: z.string().min(1),
  scheduleDays: z.array(z.number().int().min(0).max(6)),
  scheduleDayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  scheduleMonth: z.number().int().min(1).max(12).nullable().optional(),
  scheduleStartDate: z.string().nullable().optional(),
  timezone: z.string().optional(),
  resourceIds: z.array(z.string()),
  scanCategories: z.array(z.enum(['sast', 'sca', 'dast', 'iac', 'secrets'])),
  toolIds: z.array(z.string()),
  reportMode: z.enum(['separate', 'merged']).optional(),
  s3Enabled: z.boolean().optional(),
  s3Bucket: z.string().optional(),
  s3Region: z.string().optional(),
  s3Prefix: z.string().optional(),
  awsCredentialId: z.string().nullable().optional(),
  teamsEnabled: z.boolean().optional(),
  teamsWebhookUrl: z.string().optional(),
});

export const automationUpdateSchema = automationBodySchema.partial();
