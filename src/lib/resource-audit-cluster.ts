import prisma from './prisma';
import { readKubeconfigFromPath } from './kubeconfig-file';
import {
  listKnownHelmClusterNames,
  registeredClusterMatchesExpected,
  resolveClusterForGitFileChange,
} from './helm-env-cluster';

let registeredClusterCache: { at: number; names: string[] } | null = null;
const CACHE_TTL_MS = 60_000;

export async function getRegisteredClusterNames(): Promise<string[]> {
  if (!registeredClusterCache || Date.now() - registeredClusterCache.at >= CACHE_TTL_MS) {
    const rows = await prisma.cluster.findMany({
      select: { name: true, contextName: true, kubeconfigPath: true },
      orderBy: { name: 'asc' },
    });

    const names = new Set<string>();
    const kubeconfigPaths = new Set<string>();

    for (const row of rows) {
      if (row.name?.trim()) names.add(row.name.trim());
      if (row.contextName?.trim()) names.add(row.contextName.trim());
      if (row.kubeconfigPath?.trim()) kubeconfigPaths.add(row.kubeconfigPath.trim());
    }

    for (const kubeconfigPath of Array.from(kubeconfigPaths)) {
      try {
        const { contexts } = readKubeconfigFromPath(kubeconfigPath);
        for (const ctx of contexts) {
          if (ctx.name?.trim()) names.add(ctx.name.trim());
        }
      } catch {
        // skip unreadable kubeconfig paths
      }
    }

    for (const cluster of listKnownHelmClusterNames()) {
      names.add(cluster);
    }

    registeredClusterCache = { at: Date.now(), names: Array.from(names).sort() };
  }
  return registeredClusterCache.names;
}

/** Map helm env folder → registered cluster name when possible. */
export async function resolveAuditClusterName(input: {
  filePath: string;
  branch?: string | null;
  fallbackCluster?: string | null;
}): Promise<string> {
  const expected = resolveClusterForGitFileChange(input);
  const registered = await getRegisteredClusterNames();
  const match = registered.find((name) => registeredClusterMatchesExpected(name, expected));
  if (match) return match;
  if (registered.includes(expected)) return expected;
  return input.fallbackCluster?.trim() || expected;
}

/** Cluster filter values that match a registered cluster selection (exact cluster, no account bleed). */
export async function expandClusterFilterValues(selectedCluster: string): Promise<string[]> {
  const variants = new Set<string>([selectedCluster]);
  const registered = await getRegisteredClusterNames();

  for (const name of registered) {
    if (registeredClusterMatchesExpected(name, selectedCluster)) {
      variants.add(name);
    }
    if (registeredClusterMatchesExpected(selectedCluster, name)) {
      variants.add(name);
    }
  }

  for (const mapped of listKnownHelmClusterNames()) {
    if (
      mapped === selectedCluster ||
      registeredClusterMatchesExpected(selectedCluster, mapped) ||
      registeredClusterMatchesExpected(mapped, selectedCluster)
    ) {
      variants.add(mapped);
    }
  }

  return Array.from(variants);
}

export function invalidateResourceAuditClusterCache() {
  registeredClusterCache = null;
}
