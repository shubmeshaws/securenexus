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
  .regex(/^(Deployment|StatefulSet|DaemonSet|CronJob|ScaledJob)::.+$/);

const scheduleIdentitySchema = z.object({
  name: z.string().min(1).max(100),
  platformType: z.enum(['eks', 'non_eks']).optional().default('eks'),
  cluster: z.string().min(1),
  namespace: z.string().min(1),
  scope: z.enum(['workload', 'namespace']).optional().default('workload'),
  appName: z.string().optional(),
  workloadKind: z
    .enum(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'ScaledJob', 'Namespace', 'EC2'])
    .optional()
    .default('Deployment'),
  excludedWorkloads: z.array(workloadKeySchema).optional().default([]),
  awsCredentialId: z.string().optional().nullable(),
  ec2InstanceId: z.string().optional().nullable(),
  ec2Region: z.string().optional().nullable(),
  timezone: z.string().min(1),
  syncPolicy: z.enum(['automated', 'none']),
  argocdInstanceId: z.union([z.string().min(1), z.null()]).optional(),
  targetReplicas: z.number().int().min(0).max(100),
  enabled: z.boolean().optional().default(true),
  teamsAlertEnabled: z.boolean().optional().default(true),
});

const timeString = z.string().regex(/^\d{2}:\d{2}$/);

const dailyTimingSchema = z.object({
  recurrence: z.literal('daily').optional().default('daily'),
  shutdownTime: timeString,
  startupTime: timeString,
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1),
  oneTimeShutdownAt: z.null().optional(),
  oneTimeStartupAt: z.null().optional(),
});

const splitTimingSchema = z.object({
  recurrence: z.literal('split'),
  // Weekday-window times:
  shutdownTime: timeString,
  startupTime: timeString,
  // Weekend-window times:
  weekendShutdownTime: timeString,
  weekendStartupTime: timeString,
  // All active days (union of both windows):
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1),
  // Subset of daysOfWeek that use the weekend window:
  weekendDays: z.array(z.number().int().min(1).max(7)).optional().default([]),
  oneTimeShutdownAt: z.null().optional(),
  oneTimeStartupAt: z.null().optional(),
});

const onetimeTimingSchema = z.object({
  recurrence: z.literal('onetime'),
  oneTimeShutdownAt: z.string().min(1),
  oneTimeStartupAt: z.string().min(1),
  shutdownTime: timeString.optional(),
  startupTime: timeString.optional(),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).optional().default([]),
});

const scheduleBaseSchema = z.discriminatedUnion('recurrence', [
  scheduleIdentitySchema.merge(dailyTimingSchema),
  scheduleIdentitySchema.merge(splitTimingSchema),
  scheduleIdentitySchema.merge(onetimeTimingSchema),
]);

type ScheduleInput = z.infer<typeof scheduleBaseSchema>;

function normalizeScope<T extends ScheduleInput>(data: T) {
  if (data.platformType === 'non_eks') {
    return {
      ...data,
      scope: 'workload' as const,
      appName: data.appName ?? '',
      workloadKind: 'EC2' as const,
      excludedWorkloads: [] as string[],
      syncPolicy: 'none' as const,
      argocdInstanceId: null,
      namespace: data.ec2Region ?? data.namespace,
    };
  }

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
      weekendShutdownTime: null,
      weekendStartupTime: null,
      weekendDays: [] as number[],
      daysOfWeek: [] as number[],
      oneTimeShutdownAt: shutdownAt,
      oneTimeStartupAt: startupAt,
      oneTimeCompleted: false,
    };
  }

  if (scoped.recurrence === 'split') {
    // weekendDays must be a subset of the active days.
    const weekendDays = (scoped.weekendDays ?? []).filter((d) => scoped.daysOfWeek.includes(d));
    return {
      ...scoped,
      recurrence: 'split' as const,
      weekendShutdownTime: scoped.weekendShutdownTime,
      weekendStartupTime: scoped.weekendStartupTime,
      weekendDays,
      oneTimeShutdownAt: null,
      oneTimeStartupAt: null,
      oneTimeCompleted: false,
    };
  }

  return {
    ...scoped,
    recurrence: 'daily' as const,
    weekendShutdownTime: null,
    weekendStartupTime: null,
    weekendDays: [] as number[],
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
  .refine(
    (data) =>
      data.platformType === 'non_eks' ||
      data.scope !== 'workload' ||
      (data.appName?.length ?? 0) > 0,
    {
      message: 'Workload is required for single-workload schedules',
      path: ['appName'],
    }
  )
  .refine(
    (data) =>
      data.platformType !== 'non_eks' ||
      ((data.appName?.length ?? 0) > 0 &&
        Boolean(data.awsCredentialId) &&
        Boolean(data.ec2InstanceId) &&
        Boolean(data.ec2Region)),
    {
      message: 'AWS account and EC2 instance are required for Non-EKS schedules',
      path: ['ec2InstanceId'],
    }
  );

export const updateScheduleBodySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    platformType: z.enum(['eks', 'non_eks']).optional(),
    cluster: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
    scope: z.enum(['workload', 'namespace']).optional(),
    appName: z.string().optional(),
    workloadKind: z
      .enum(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'ScaledJob', 'Namespace', 'EC2'])
      .optional(),
    excludedWorkloads: z.array(workloadKeySchema).optional(),
    awsCredentialId: z.union([z.string().min(1), z.null()]).optional(),
    ec2InstanceId: z.union([z.string().min(1), z.null()]).optional(),
    ec2Region: z.union([z.string().min(1), z.null()]).optional(),
    timezone: z.string().min(1).optional(),
    syncPolicy: z.enum(['automated', 'none']).optional(),
    argocdInstanceId: z.union([z.string().min(1), z.null()]).optional(),
    targetReplicas: z.number().int().min(0).max(100).optional(),
    enabled: z.boolean().optional(),
    teamsAlertEnabled: z.boolean().optional(),
    recurrence: z.enum(['daily', 'onetime', 'split']).optional(),
    shutdownTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    startupTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    weekendShutdownTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    weekendStartupTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    weekendDays: z.array(z.number().int().min(1).max(7)).optional(),
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
    platformType: (patch.platformType ?? existing.platformType ?? 'eks') as 'eks' | 'non_eks',
    cluster: patch.cluster ?? existing.cluster,
    namespace: patch.namespace ?? existing.namespace,
    scope: (patch.scope ?? existing.scope) as 'workload' | 'namespace',
    appName: patch.appName ?? existing.appName,
    workloadKind: patch.workloadKind ?? existing.workloadKind,
    excludedWorkloads: patch.excludedWorkloads ?? existing.excludedWorkloads,
    awsCredentialId:
      patch.awsCredentialId !== undefined ? patch.awsCredentialId : existing.awsCredentialId,
    ec2InstanceId: patch.ec2InstanceId !== undefined ? patch.ec2InstanceId : existing.ec2InstanceId,
    ec2Region: patch.ec2Region !== undefined ? patch.ec2Region : existing.ec2Region,
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

  if (recurrence === 'split') {
    return wrapNormalize({
      ...base,
      workloadKind: base.workloadKind as ScheduleInput['workloadKind'],
      recurrence: 'split',
      shutdownTime: patch.shutdownTime ?? existing.shutdownTime,
      startupTime: patch.startupTime ?? existing.startupTime,
      weekendShutdownTime: patch.weekendShutdownTime ?? existing.weekendShutdownTime ?? '',
      weekendStartupTime: patch.weekendStartupTime ?? existing.weekendStartupTime ?? '',
      weekendDays: patch.weekendDays ?? existing.weekendDays,
      daysOfWeek: patch.daysOfWeek ?? existing.daysOfWeek,
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
