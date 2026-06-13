import { z } from 'zod';
import type { Schedule } from '@prisma/client';
import {
  formatZonedDatetimeInput,
  parseZonedDatetimeInput,
  timeFromZonedInstant,
} from './schedule-recurrence';

export const syncPolicySchema = z.object({
  syncPolicy: z.enum(['automated', 'none']),
});

export const scaleDeploymentSchema = z.object({
  replicas: z.number().int().min(0).max(100),
});

const workloadKeySchema = z
  .string()
  .regex(/^(Deployment|StatefulSet|DaemonSet)::.+$/);

const scheduleIdentitySchema = z.object({
  name: z.string().min(1).max(100),
  cluster: z.string().min(1),
  namespace: z.string().min(1),
  scope: z.enum(['workload', 'namespace']).optional().default('workload'),
  appName: z.string().optional(),
  workloadKind: z
    .enum(['Deployment', 'StatefulSet', 'DaemonSet', 'Namespace'])
    .optional()
    .default('Deployment'),
  excludedWorkloads: z.array(workloadKeySchema).optional().default([]),
  timezone: z.string().min(1),
  syncPolicy: z.enum(['automated', 'none']),
  argocdInstanceId: z.union([z.string().min(1), z.null()]).optional(),
  targetReplicas: z.number().int().min(0).max(100),
  enabled: z.boolean().optional().default(true),
  teamsAlertEnabled: z.boolean().optional().default(true),
});

const dailyTimingSchema = z.object({
  recurrence: z.literal('daily').optional().default('daily'),
  shutdownTime: z.string().regex(/^\d{2}:\d{2}$/),
  startupTime: z.string().regex(/^\d{2}:\d{2}$/),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1),
  oneTimeShutdownAt: z.null().optional(),
  oneTimeStartupAt: z.null().optional(),
});

const onetimeTimingSchema = z.object({
  recurrence: z.literal('onetime'),
  oneTimeShutdownAt: z.string().min(1),
  oneTimeStartupAt: z.string().min(1),
  shutdownTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  startupTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).optional().default([]),
});

const scheduleBaseSchema = z.discriminatedUnion('recurrence', [
  scheduleIdentitySchema.merge(dailyTimingSchema),
  scheduleIdentitySchema.merge(onetimeTimingSchema),
]);

type ScheduleInput = z.infer<typeof scheduleBaseSchema>;

function normalizeScope<T extends ScheduleInput>(data: T) {
  if (data.scope === 'namespace') {
    return {
      ...data,
      appName: '*',
      workloadKind: 'Namespace' as const,
    };
  }
  return {
    ...data,
    appName: data.appName ?? '',
    excludedWorkloads: [] as string[],
  };
}

function normalizeScheduleInput(data: ScheduleInput) {
  const scoped = normalizeScope(data);

  if (scoped.recurrence === 'onetime') {
    const shutdownAt = parseZonedDatetimeInput(scoped.oneTimeShutdownAt, scoped.timezone);
    const startupAt = parseZonedDatetimeInput(scoped.oneTimeStartupAt, scoped.timezone);
    if (startupAt <= shutdownAt) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: 'Startup must be after shutdown',
          path: ['oneTimeStartupAt'],
        },
      ]);
    }

    return {
      ...scoped,
      shutdownTime: timeFromZonedInstant(shutdownAt, scoped.timezone),
      startupTime: timeFromZonedInstant(startupAt, scoped.timezone),
      daysOfWeek: [] as number[],
      oneTimeShutdownAt: shutdownAt,
      oneTimeStartupAt: startupAt,
      oneTimeCompleted: false,
    };
  }

  return {
    ...scoped,
    recurrence: 'daily' as const,
    oneTimeShutdownAt: null,
    oneTimeStartupAt: null,
    oneTimeCompleted: false,
  };
}

function wrapNormalize(data: ScheduleInput) {
  try {
    return normalizeScheduleInput(data);
  } catch (err) {
    if (err instanceof z.ZodError) throw err;
    throw new z.ZodError([
      {
        code: 'custom',
        message: err instanceof Error ? err.message : 'Invalid schedule timing',
        path: ['oneTimeShutdownAt'],
      },
    ]);
  }
}

export const createScheduleSchema = z
  .preprocess((val) => ({ recurrence: 'daily', ...(val as object) }), scheduleBaseSchema)
  .transform(wrapNormalize)
  .refine((data) => data.scope !== 'workload' || data.appName.length > 0, {
    message: 'Workload is required for single-workload schedules',
    path: ['appName'],
  });

export const updateScheduleBodySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    cluster: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
    scope: z.enum(['workload', 'namespace']).optional(),
    appName: z.string().optional(),
    workloadKind: z
      .enum(['Deployment', 'StatefulSet', 'DaemonSet', 'Namespace'])
      .optional(),
    excludedWorkloads: z.array(workloadKeySchema).optional(),
    timezone: z.string().min(1).optional(),
    syncPolicy: z.enum(['automated', 'none']).optional(),
    argocdInstanceId: z.union([z.string().min(1), z.null()]).optional(),
    targetReplicas: z.number().int().min(0).max(100).optional(),
    enabled: z.boolean().optional(),
    teamsAlertEnabled: z.boolean().optional(),
    recurrence: z.enum(['daily', 'onetime']).optional(),
    shutdownTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    startupTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    daysOfWeek: z.array(z.number().int().min(1).max(7)).optional(),
    oneTimeShutdownAt: z.string().min(1).optional(),
    oneTimeStartupAt: z.string().min(1).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

export function mergeScheduleUpdate(existing: Schedule, patch: z.infer<typeof updateScheduleBodySchema>) {
  const recurrence = patch.recurrence ?? existing.recurrence ?? 'daily';
  const timezone = patch.timezone ?? existing.timezone;

  const base = {
    name: patch.name ?? existing.name,
    cluster: patch.cluster ?? existing.cluster,
    namespace: patch.namespace ?? existing.namespace,
    scope: (patch.scope ?? existing.scope) as 'workload' | 'namespace',
    appName: patch.appName ?? existing.appName,
    workloadKind: patch.workloadKind ?? existing.workloadKind,
    excludedWorkloads: patch.excludedWorkloads ?? existing.excludedWorkloads,
    timezone,
    syncPolicy: (patch.syncPolicy ?? existing.syncPolicy) as 'automated' | 'none',
    argocdInstanceId:
      patch.argocdInstanceId !== undefined ? patch.argocdInstanceId : existing.argocdInstanceId,
    targetReplicas: patch.targetReplicas ?? existing.targetReplicas,
    enabled: patch.enabled ?? existing.enabled,
    teamsAlertEnabled: patch.teamsAlertEnabled ?? existing.teamsAlertEnabled,
  };

  if (recurrence === 'onetime') {
    const shutdownInput =
      patch.oneTimeShutdownAt ??
      (existing.oneTimeShutdownAt
        ? formatZonedDatetimeInput(existing.oneTimeShutdownAt, timezone)
        : '');
    const startupInput =
      patch.oneTimeStartupAt ??
      (existing.oneTimeStartupAt
        ? formatZonedDatetimeInput(existing.oneTimeStartupAt, timezone)
        : '');

    if (!shutdownInput || !startupInput) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: 'Shutdown and startup date/time are required for one-time schedules',
          path: ['oneTimeShutdownAt'],
        },
      ]);
    }

    return wrapNormalize({
      ...base,
      workloadKind: base.workloadKind as ScheduleInput['workloadKind'],
      recurrence: 'onetime',
      oneTimeShutdownAt: shutdownInput,
      oneTimeStartupAt: startupInput,
      daysOfWeek: [],
    } as ScheduleInput);
  }

  return wrapNormalize({
    ...base,
    workloadKind: base.workloadKind as ScheduleInput['workloadKind'],
    recurrence: 'daily',
    shutdownTime: patch.shutdownTime ?? existing.shutdownTime,
    startupTime: patch.startupTime ?? existing.startupTime,
    daysOfWeek: patch.daysOfWeek ?? existing.daysOfWeek,
  } as ScheduleInput);
}

export const argocdLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const runScheduleSchema = z.object({
  mode: z.enum(['shutdown', 'startup']).optional().default('shutdown'),
});
