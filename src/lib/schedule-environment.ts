import { HELM_VALUES_ENV_NAMES, listHelmEnvsForCluster } from './helm-env-cluster';
import { parseClusterDisplay } from './utils';

const GENERIC_LABELS: Record<string, string> = {
  prod: 'Production',
  production: 'Production',
  dev: 'DEV',
  develop: 'DEV',
  development: 'DEV',
  stg: 'Staging',
  staging: 'Staging',
  uat: 'UAT',
  qa: 'QA',
  test: 'QA',
  testing: 'QA',
  dr: 'DR',
};

/** Generic namespace names (exact match). */
const GENERIC_NAMESPACE_PATTERNS: [RegExp, string][] = [
  [/^prod(uction)?$/i, 'Production'],
  [/^dev(elop(ment)?)?$/i, 'DEV'],
  [/^(stg|staging)$/i, 'Staging'],
  [/^uat$/i, 'UAT'],
  [/^(qa|test(ing)?)$/i, 'QA'],
  [/^(dr|disaster[-_]?recovery)$/i, 'DR'],
];

const HELM_ENVS_BY_LENGTH = [...HELM_VALUES_ENV_NAMES].sort((a, b) => b.length - a.length);

function formatEnvName(env: string): string {
  const lower = env.trim().toLowerCase();
  return GENERIC_LABELS[lower] ?? env.toUpperCase();
}

function namespaceMatchesEnv(namespace: string, env: string): boolean {
  const ns = namespace.trim().toLowerCase();
  const e = env.toLowerCase();
  if (!ns || !e) return false;
  if (ns === e) return true;
  if (ns.startsWith(`${e}-`)) return true;
  if (ns.endsWith(`-${e}`)) return true;
  if (ns.includes(`-${e}-`)) return true;
  return false;
}

/** Extract a known env token from a cluster name (e.g. pfpt-eks-cluster → pfpt). */
function envFromClusterName(clusterName: string): string | null {
  const lower = clusterName.trim().toLowerCase();
  if (!lower) return null;

  for (const env of HELM_ENVS_BY_LENGTH) {
    if (lower === env) return env;
    if (lower.startsWith(`${env}-`)) return env;
    if (lower.endsWith(`-${env}`)) return env;
    if (lower.includes(`-${env}-`)) return env;
  }

  const generic = lower.match(/^(prod|dev|stg|staging|uat|qa|dr|test)(?:-|$)/i);
  return generic?.[1]?.toLowerCase() ?? null;
}

function pickClusterMappedEnv(clusterEnvs: string[], namespace: string, clusterName: string): string | null {
  const ns = namespace.trim();
  if (ns) {
    for (const env of clusterEnvs) {
      if (namespaceMatchesEnv(ns, env)) return env;
    }
  }

  const fromName = envFromClusterName(clusterName);
  if (fromName && clusterEnvs.includes(fromName)) return fromName;

  if (clusterEnvs.length === 1) return clusterEnvs[0];

  // Shared dev cluster: namespace "default" → prefer cluster-name hint (dev-eks → dev)
  if (fromName) return fromName;

  return null;
}

/**
 * Best-effort environment label from namespace + registered cluster.
 * Uses helm-charts env folders, cluster→env mapping, then generic patterns.
 */
export function inferScheduleEnvironment(namespace: string, cluster: string): string {
  const ns = namespace?.trim() ?? '';
  const { clusterName } = parseClusterDisplay(cluster);

  if (ns) {
    const nsLower = ns.toLowerCase();
    for (const env of HELM_ENVS_BY_LENGTH) {
      if (nsLower === env) return formatEnvName(env);
    }
    for (const env of HELM_ENVS_BY_LENGTH) {
      if (namespaceMatchesEnv(ns, env)) return formatEnvName(env);
    }
    for (const [pattern, label] of GENERIC_NAMESPACE_PATTERNS) {
      if (pattern.test(ns)) return label;
    }
  }

  const clusterEnvs = listHelmEnvsForCluster(cluster);
  const mapped = pickClusterMappedEnv(clusterEnvs, ns, clusterName);
  if (mapped) return formatEnvName(mapped);

  const fromClusterName = envFromClusterName(clusterName);
  if (fromClusterName) return formatEnvName(fromClusterName);

  const legacyMatch = clusterName.match(/^(prod|dev|stg|staging|uat|qa|dr|test)-/i);
  if (legacyMatch) return formatEnvName(legacyMatch[1]);

  return ns || clusterName || '—';
}
