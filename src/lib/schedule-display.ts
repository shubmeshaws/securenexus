import type { Schedule } from '@prisma/client';
import prisma from './prisma';
import { parseClusterDisplay } from './utils';

export async function enrichSchedulesWithAccountId<T extends Schedule>(
  schedules: T[]
): Promise<Array<T & { awsAccountId: string | null; liveStoppedByName: string | null }>> {
  const allCreds = await prisma.awsCredential.findMany({
    select: { id: true, name: true, awsAccountId: true },
  });

  const accountByCredId = new Map<string, string | null>();
  const accountByCredName = new Map<string, string | null>();

  for (const cred of allCreds) {
    accountByCredId.set(cred.id, cred.awsAccountId ?? null);
    accountByCredName.set(cred.name, cred.awsAccountId ?? null);
  }

  const stopperEmails = Array.from(
    new Set(
      schedules
        .map((schedule) => schedule.liveStoppedBy)
        .filter((email): email is string => Boolean(email))
    )
  );

  const stopperUsers =
    stopperEmails.length > 0
      ? await prisma.user.findMany({
          where: { email: { in: stopperEmails } },
          select: { email: true, displayName: true },
        })
      : [];

  const displayNameByEmail = new Map(
    stopperUsers.map((user) => [user.email, user.displayName])
  );

  return schedules.map((schedule) => {
    const fromCluster = parseClusterDisplay(schedule.cluster).accountId;
    const fromCredId = schedule.awsCredentialId
      ? accountByCredId.get(schedule.awsCredentialId) ?? null
      : null;
    const fromCredName =
      schedule.platformType === 'non_eks' ? accountByCredName.get(schedule.cluster) ?? null : null;

    const liveStoppedByName = schedule.liveStoppedBy
      ? displayNameByEmail.get(schedule.liveStoppedBy) ??
        schedule.liveStoppedBy.split('@')[0]
      : null;

    return {
      ...schedule,
      awsAccountId: fromCluster ?? fromCredId ?? fromCredName ?? null,
      liveStoppedByName,
    };
  });
}
