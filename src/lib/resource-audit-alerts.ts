import { getAlertConfigFull, getTeamsWebhookUrl, shouldAlertForEvent } from './alert-settings';
import { sendTeamsWebhook, buildResourceChangeTeamsCard } from './teams-webhook';
import { sendEmailAlert } from './email-alerts';
import { logActivity } from './activity';
import type { ResourceChangeInput } from './resource-audit-types';
import { RESOURCE_TYPE_LABELS, REPLICAS_CONTAINER_MARKER } from './resource-audit-types';
import type { ResourceAuditType } from './resource-audit-types';
import { parseClusterDisplay } from './utils';

export interface ResourceChangeAlertInput {
  argocdApp: string;
  cluster: string;
  namespace: string;
  authorName: string;
  authorEmail: string | null;
  revisionSha: string;
  commitMessage: string | null;
  changes: ResourceChangeInput[];
  totalCostImpactPerDay: number;
}

function formatChangeLine(change: ResourceChangeInput): string {
  const type = change.resourceType as ResourceAuditType;
  const label = RESOURCE_TYPE_LABELS[type] ?? type;
  const target =
    change.containerName === REPLICAS_CONTAINER_MARKER
      ? change.workload
      : `${change.workload}/${change.containerName}`;
  return `${target} · ${label}: ${change.oldValue} → ${change.newValue}`;
}

export async function dispatchResourceChangeAlert(
  input: ResourceChangeAlertInput
): Promise<boolean> {
  try {
    const config = await getAlertConfigFull();
    if (!shouldAlertForEvent(config, 'resource-change')) return false;

    const { clusterName } = parseClusterDisplay(input.cluster);
    const changeLines = input.changes.map(formatChangeLine).join('; ');
    const message = `Resource increase on ${input.argocdApp} (+$${input.totalCostImpactPerDay.toFixed(2)}/day)`;

    await logActivity({
      action: 'resource-change',
      cluster: input.cluster,
      namespace: input.namespace,
      appName: input.argocdApp,
      triggeredBy: input.authorEmail ?? input.authorName,
      status: 'success',
      message,
      details: JSON.stringify({
        revisionSha: input.revisionSha,
        totalCostImpactPerDay: input.totalCostImpactPerDay,
        changes: input.changes.length,
      }),
      userName: input.authorName,
      userEmail: input.authorEmail ?? undefined,
    });

    const teamsPayload = buildResourceChangeTeamsCard({
      argocdApp: input.argocdApp,
      cluster: clusterName,
      namespace: input.namespace,
      authorName: input.authorName,
      authorEmail: input.authorEmail,
      revisionSha: input.revisionSha,
      commitMessage: input.commitMessage,
      changes: input.changes.map((c) => ({
        workload: c.workload,
        containerName: c.containerName,
        resourceType: c.resourceType,
        oldValue: c.oldValue,
        newValue: c.newValue,
        costImpact: c.estimatedCostImpactPerDay,
      })),
      totalCostImpactPerDay: input.totalCostImpactPerDay,
    });

    const tasks: Promise<unknown>[] = [];

    if (config.teamsEnabled) {
      const webhookUrl = await getTeamsWebhookUrl();
      if (webhookUrl) {
        tasks.push(sendTeamsWebhook(webhookUrl, teamsPayload));
      }
    }

    if (config.emailEnabled) {
      tasks.push(
        sendEmailAlert(config, {
          title: 'Resource increase detected',
          message: changeLines,
          action: 'resource-change',
          cluster: input.cluster,
          namespace: input.namespace,
          appName: input.argocdApp,
          triggeredBy: input.authorEmail ?? input.authorName,
          status: 'success',
          userName: input.authorName,
        })
      );
    }

    await Promise.allSettled(tasks);
    return true;
  } catch {
    return false;
  }
}
