import { z } from 'zod';
import type { Schedule } from '@prisma/client';
import {
  formatZonedDatetimeInput,
  parseZonedDatetimeInput,
  timeFromZonedInstant,
} from './schedule-recurrence';
import { startupAfterShutdown } from './schedule-window';
import { combinedActiveDays } from './schedule-combined';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { setHours, setMinutes, getDay, addDays } from 'date-fns';

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

const windowTimingSchema = z.object({
  recurrence: z.literal('window'),
  shutdownTime: timeString,
  startupTime: timeString,
  shutdownDayOfWeek: z.number().int().min(1).max(7),
  startupDayOfWeek: z.number().int().min(1).max(7),
  windowRepeatWeekly: z.boolean().optional().default(true),
  oneTimeShutdownAt: z.string().optional().nullable(),
  oneTimeStartupAt: z.string().optional().nullable(),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).optional().default([]),
});

const combinedTimingSchema = z.object({
  recurrence: z.literal('combined'),
  shutdownTime: timeString,
  startupTime: timeString,
  shutdownDayOfWeek: z.number().int().min(1).max(7),
  startupDayOfWeek: z.number().int().min(1).max(7),
  overnightDays: z.array(z.number().int().min(1).max(7)).optional().default([]),
  overnightShutdownTime: timeString,
  overnightStartupTime: timeString,
  windowRepeatWeekly: z.literal(true).optional().default(true),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).optional().default([]),
});

const scheduleBaseSchema = z.discriminatedUnion('recurrence', [
  scheduleIdentitySchema.merge(dailyTimingSchema),
  scheduleIdentitySchema.merge(splitTimingSchema),
  scheduleIdentitySchema.merge(onetimeTimingSchema),
  scheduleIdentitySchema.merge(windowTimingSchema),
  scheduleIdentitySchema.merge(combinedTimingSchema),
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

function isoDayFromZonedDate(zoned: Date): number {
  const d = getDay(zoned);
  return d === 0 ? 7 : d;
}

function windowShutdownInstant(
  shutdownDay: number,
  shutdownTime: string,
  timezone: string
): Date {
  const now = new Date();
  const zoned = toZonedTime(now, timezone);
  const [h, m] = shutdownTime.split(':').map(Number);
  for (let offset = 0; offset < 7; offset++) {
    const candidate = addDays(zoned, offset);
    if (isoDayFromZonedDate(candidate) !== shutdownDay) continue;
    const local = setMinutes(setHours(candidate, h), m);
    return fromZonedTime(local, timezone);
  }
  throw new Error('Invalid shutdown day');
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
      shutdownDayOfWeek: null,
      startupDayOfWeek: null,
      windowRepeatWeekly: true,
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
      shutdownDayOfWeek: null,
      startupDayOfWeek: null,
      windowRepeatWeekly: true,
      oneTimeShutdownAt: null,
      oneTimeStartupAt: null,
      oneTimeCompleted: false,
    };
  }

  if (scoped.recurrence === 'window') {
    if (scoped.windowRepeatWeekly === false) {
      const shutdownInput = scoped.oneTimeShutdownAt;
      const startupInput = scoped.oneTimeStartupAt;
      if (!shutdownInput || !startupInput) {
        throw new z.ZodError([
          {
            code: 'custom',
            message: 'Shutdown and startup date/time are required when repeat is off',
            path: ['oneTimeShutdownAt'],
          },
        ]);
      }
      const shutdownAt = parseZonedDatetimeInput(shutdownInput, scoped.timezone);
      const startupAt = parseZonedDatetimeInput(startupInput, scoped.timezone);
      if (startupAt <= shutdownAt) {
        throw new z.ZodError([
          {
            code: 'custom',
            message: 'Startup must be after shutdown',
            path: ['oneTimeStartupAt'],
          },
        ]);
      }
      const shutdownZoned = toZonedTime(shutdownAt, scoped.timezone);
      const startupZoned = toZonedTime(startupAt, scoped.timezone);
      return {
        ...scoped,
        recurrence: 'window' as const,
        shutdownTime: timeFromZonedInstant(shutdownAt, scoped.timezone),
        startupTime: timeFromZonedInstant(startupAt, scoped.timezone),
        shutdownDayOfWeek: isoDayFromZonedDate(shutdownZoned),
        startupDayOfWeek: isoDayFromZonedDate(startupZoned),
        windowRepeatWeekly: false,
        weekendShutdownTime: null,
        weekendStartupTime: null,
        weekendDays: [] as number[],
        daysOfWeek: [] as number[],
        oneTimeShutdownAt: shutdownAt,
        oneTimeStartupAt: startupAt,
        oneTimeCompleted: false,
      };
    }

    const shutdownDay = scoped.shutdownDayOfWeek;
    const startupDay = scoped.startupDayOfWeek;
    const refShutdown = windowShutdownInstant(shutdownDay, scoped.shutdownTime, scoped.timezone);
    const refStartup = startupAfterShutdown(
      {
        recurrence: 'window',
        timezone: scoped.timezone,
        shutdownTime: scoped.shutdownTime,
        startupTime: scoped.startupTime,
        shutdownDayOfWeek: shutdownDay,
        startupDayOfWeek: startupDay,
        windowRepeatWeekly: true,
        oneTimeShutdownAt: null,
        oneTimeStartupAt: null,
        oneTimeCompleted: false,
        enabled: true,
      },
      refShutdown
    );
    if (!refStartup || refStartup <= refShutdown) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: 'Startup day/time must be after shutdown day/time in the same cycle',
          path: ['startupDayOfWeek'],
        },
      ]);
    }

    return {
      ...scoped,
      recurrence: 'window' as const,
      shutdownDayOfWeek: shutdownDay,
      startupDayOfWeek: startupDay,
      windowRepeatWeekly: true,
      weekendShutdownTime: null,
      weekendStartupTime: null,
      weekendDays: [] as number[],
      daysOfWeek: Array.from(new Set([shutdownDay, startupDay])).sort((a, b) => a - b),
      oneTimeShutdownAt: null,
      oneTimeStartupAt: null,
      oneTimeCompleted: false,
      overnightDays: [] as number[],
      overnightShutdownTime: null,
      overnightStartupTime: null,
    };
  }

  if (scoped.recurrence === 'combined') {
    const shutdownDay = scoped.shutdownDayOfWeek;
    const startupDay = scoped.startupDayOfWeek;
    const overnightDays = scoped.overnightDays ?? [];

    const [oShH, oShM] = scoped.overnightShutdownTime.split(':').map(Number);
    const [oStH, oStM] = scoped.overnightStartupTime.split(':').map(Number);
    if (oShH * 60 + oShM >= oStH * 60 + oStM) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: 'Overnight startup must be after overnight shutdown on the same day',
          path: ['overnightStartupTime'],
        },
      ]);
    }

    const refShutdown = windowShutdownInstant(shutdownDay, scoped.shutdownTime, scoped.timezone);
    const refStartup = startupAfterShutdown(
      {
        recurrence: 'window',
        timezone: scoped.timezone,
        shutdownTime: scoped.shutdownTime,
        startupTime: scoped.startupTime,
        shutdownDayOfWeek: shutdownDay,
        startupDayOfWeek: startupDay,
        windowRepeatWeekly: true,
        oneTimeShutdownAt: null,
        oneTimeStartupAt: null,
        oneTimeCompleted: false,
        enabled: true,
      },
      refShutdown
    );
    if (!refStartup || refStartup <= refShutdown) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: 'Long stop: startup day/time must be after shutdown day/time',
          path: ['startupDayOfWeek'],
        },
      ]);
    }

    const combined = {
      recurrence: 'combined' as const,
      shutdownDayOfWeek: shutdownDay,
      startupDayOfWeek: startupDay,
      shutdownTime: scoped.shutdownTime,
      startupTime: scoped.startupTime,
      overnightDays,
      overnightShutdownTime: scoped.overnightShutdownTime,
      overnightStartupTime: scoped.overnightStartupTime,
      windowRepeatWeekly: true as const,
      weekendShutdownTime: null,
      weekendStartupTime: null,
      weekendDays: [] as number[],
      oneTimeShutdownAt: null,
      oneTimeStartupAt: null,
      oneTimeCompleted: false,
    };

    return {
      ...scoped,
      ...combined,
      daysOfWeek: combinedActiveDays(combined),
    };
  }

  return {
    ...scoped,
    recurrence: 'daily' as const,
    weekendShutdownTime: null,
    weekendStartupTime: null,
    weekendDays: [] as number[],
    shutdownDayOfWeek: null,
    startupDayOfWeek: null,
    windowRepeatWeekly: true,
    overnightDays: [] as number[],
    overnightShutdownTime: null,
    overnightStartupTime: null,
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
    recurrence: z.enum(['daily', 'onetime', 'split', 'window', 'combined']).optional(),
    shutdownTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    startupTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    shutdownDayOfWeek: z.number().int().min(1).max(7).optional(),
    startupDayOfWeek: z.number().int().min(1).max(7).optional(),
    windowRepeatWeekly: z.boolean().optional(),
    overnightDays: z.array(z.number().int().min(1).max(7)).optional(),
    overnightShutdownTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    overnightStartupTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
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

  if (recurrence === 'window') {
    const windowRepeatWeekly =
      patch.windowRepeatWeekly ?? existing.windowRepeatWeekly ?? true;
    if (windowRepeatWeekly === false) {
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
            message: 'Shutdown and startup date/time are required when repeat is off',
            path: ['oneTimeShutdownAt'],
          },
        ]);
      }

      return wrapNormalize({
        ...base,
        workloadKind: base.workloadKind as ScheduleInput['workloadKind'],
        recurrence: 'window',
        shutdownTime: patch.shutdownTime ?? existing.shutdownTime,
        startupTime: patch.startupTime ?? existing.startupTime,
        shutdownDayOfWeek: patch.shutdownDayOfWeek ?? existing.shutdownDayOfWeek ?? 5,
        startupDayOfWeek: patch.startupDayOfWeek ?? existing.startupDayOfWeek ?? 1,
        windowRepeatWeekly: false,
        oneTimeShutdownAt: shutdownInput,
        oneTimeStartupAt: startupInput,
        daysOfWeek: [],
      } as ScheduleInput);
    }

    return wrapNormalize({
      ...base,
      workloadKind: base.workloadKind as ScheduleInput['workloadKind'],
      recurrence: 'window',
      shutdownTime: patch.shutdownTime ?? existing.shutdownTime,
      startupTime: patch.startupTime ?? existing.startupTime,
      shutdownDayOfWeek: patch.shutdownDayOfWeek ?? existing.shutdownDayOfWeek ?? 5,
      startupDayOfWeek: patch.startupDayOfWeek ?? existing.startupDayOfWeek ?? 1,
      windowRepeatWeekly: true,
      daysOfWeek: patch.daysOfWeek ?? existing.daysOfWeek,
    } as ScheduleInput);
  }

  if (recurrence === 'combined') {
    return wrapNormalize({
      ...base,
      workloadKind: base.workloadKind as ScheduleInput['workloadKind'],
      recurrence: 'combined',
      shutdownTime: patch.shutdownTime ?? existing.shutdownTime,
      startupTime: patch.startupTime ?? existing.startupTime,
      shutdownDayOfWeek: patch.shutdownDayOfWeek ?? existing.shutdownDayOfWeek ?? 5,
      startupDayOfWeek: patch.startupDayOfWeek ?? existing.startupDayOfWeek ?? 1,
      overnightDays: patch.overnightDays ?? existing.overnightDays ?? [],
      overnightShutdownTime:
        patch.overnightShutdownTime ?? existing.overnightShutdownTime ?? '00:00',
      overnightStartupTime:
        patch.overnightStartupTime ?? existing.overnightStartupTime ?? '07:00',
      windowRepeatWeekly: true,
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

export const instantStartSchema = z.object({
  cluster: z.string().min(1),
  namespace: z.string().min(1),
  appName: z.string().min(1),
  workloadKind: z
    .enum(['Deployment', 'StatefulSet', 'CronJob', 'ScaledJob'])
    .default('Deployment'),
  targetReplicas: z.number().int().min(1).max(100).default(1),
});
