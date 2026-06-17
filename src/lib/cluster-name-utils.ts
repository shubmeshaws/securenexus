import { parseClusterDisplay } from './utils';

/** Names used in DB/catalog that may refer to the same registered cluster. */
export function clusterNameVariants(cluster: string): string[] {
  const { accountId, clusterName } = parseClusterDisplay(cluster);
  const variants = new Set<string>([cluster.trim(), clusterName.trim()].filter(Boolean));

  if (accountId && clusterName) {
    variants.add(`${accountId}/${clusterName}`);
    variants.add(clusterName);
  }

  return Array.from(variants);
}
