import { getDeployment, listDeployments } from './k8s-client';

/** Live pod count from the cluster API (kubectl-backed client). */
export async function fetchLivePodCount(
  cluster: string,
  namespace: string,
  yamlStem: string,
  legacyDeploymentName?: string | null
): Promise<number | null> {
  const candidates = Array.from(
    new Set(
      [legacyDeploymentName, yamlStem, `${namespace}-${yamlStem}`].filter(
        (name): name is string => Boolean(name?.trim())
      )
    )
  );

  for (const name of candidates) {
    try {
      const dep = await getDeployment(cluster, namespace, name);
      if (dep) {
        return dep.readyReplicas ?? dep.availableReplicas ?? dep.replicas ?? null;
      }
    } catch {
      // try next candidate
    }
  }

  try {
    const deployments = await listDeployments(cluster, namespace);
    const stem = yamlStem.toLowerCase();
    const match = deployments.find(
      (dep) =>
        dep.name.toLowerCase() === stem ||
        dep.name.toLowerCase().endsWith(`-${stem}`) ||
        dep.name.toLowerCase().includes(stem)
    );
    if (match) {
      return match.readyReplicas ?? match.availableReplicas ?? match.replicas ?? null;
    }
  } catch {
    // cluster unreachable or namespace missing
  }

  return null;
}
