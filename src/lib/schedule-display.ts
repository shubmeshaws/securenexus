import type { Schedule } from '@prisma/client';
import { resolveEffectiveCredentials } from './aws-credential-store';
import prisma from './prisma';
import { parseClusterDisplay } from './utils';

export async function enrichSchedulesWithAccountId<T extends Schedule>(
  schedules: T[]
): Promise<Array<T & { awsAccountId: string | null }>> {
  const allCreds = await prisma.awsCredential.findMany({
    select: { id: true, name: true, awsAccountId: true },
  });

  const accountByCredId = new Map<string, string | null>();
  const accountByCredName = new Map<string, string | null>();

  for (const cred of allCreds) {
    let accountId = cred.awsAccountId;
    if (!accountId) {
      try {
        const resolved = await resolveEffectiveCredentials(cred.id);
        accountId = resolved.awsAccountId;
        if (accountId) {
          await prisma.awsCredential.update({
            where: { id: cred.id },
            data: { awsAccountId: accountId },
          });
        }
      } catch {
        // leave null
      }
    }
    accountByCredId.set(cred.id, accountId ?? null);
    accountByCredName.set(cred.name, accountId ?? null);
  }

  return schedules.map((schedule) => {
    const fromCluster = parseClusterDisplay(schedule.cluster).accountId;
    const fromCredId = schedule.awsCredentialId
      ? accountByCredId.get(schedule.awsCredentialId) ?? null
      : null;
    const fromCredName =
      schedule.platformType === 'non_eks' ? accountByCredName.get(schedule.cluster) ?? null : null;

    return {
      ...schedule,
      awsAccountId: fromCluster ?? fromCredId ?? fromCredName ?? null,
    };
  });
}
