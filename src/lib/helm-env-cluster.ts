import { parseClusterDisplay } from './utils';

/**
 * helm-charts repo layout (branch `main`):
 *
 *   values/{environment_name}/applications/{application_group}/{service}.yaml
 *   values/{environment_name}/tools/{tool}.yaml
 *
 * Examples:
 *   values/pfpt/applications/rms/backend-server.yaml  → pfpt / pfpt-rms / pfpt-rms-backend-server
 *   values/pfin/tools/mongodb.yaml                    → pfin / pfin / pfin-mongodb
 *   values/pfuat/applications/sms/sms-service.yaml    → pfuat / pfuat-sms / pfuat-sms-sms-service
 */

export interface HelmAppSourceRef {
  argocdApp?: string;
  namespace?: string | null;
  helmValueFiles: string[];
}

/** Environment folder names under `values/` in helm-charts. */
export const HELM_VALUES_ENV_NAMES = [
  'dev',
  'nv',
  'sit',
  'pftech',
  'pfin',
  'pfpt',
  'pftest',
  'pfuat',
  'uat',
  'prod',
  'pfai',
  'minikube',
] as const;

export type HelmValuesEnvName = (typeof HELM_VALUES_ENV_NAMES)[number];

/**
 * Environment → EKS cluster for helm-charts `main` branch.
 *
 * | Account        | Cluster              | Environments              |
 * |----------------|----------------------|---------------------------|
 * | 546419128141   | dev-eks-cluster      | dev, nv, sit, pftech, pfin |
 * | 864651799930   | uat-eks-cluster      | uat, pfuat                |
 * | 811690671382   | pfpt-eks-cluster     | pfpt, pftest              |
 * | 811690671382   | prod-eks-cluster     | prod                      |
 * | 811690671382   | pfai-eks-cluster     | pfai                      |
 */
const MAIN_BRANCH_ENV_CLUSTER: Record<string, string> = {
  dev: '546419128141/dev-eks-cluster',
  nv: '546419128141/dev-eks-cluster',
  sit: '546419128141/dev-eks-cluster',
  pftech: '546419128141/dev-eks-cluster',
  pfin: '546419128141/dev-eks-cluster',
  uat: '864651799930/uat-eks-cluster',
  pfuat: '864651799930/uat-eks-cluster',
  pfpt: '811690671382/pfpt-eks-cluster',
  pftest: '811690671382/pfpt-eks-cluster',
  prod: '811690671382/prod-eks-cluster',
  pfai: '811690671382/pfai-eks-cluster',
};

/**
 * selectprism helm-charts branch `main-selectprism`:
 *   745772682290 → nv, sit, uat
 *   739187118197 → prod
 */
const SELECTPRISM_BRANCH = 'main-selectprism';
const SELECTPRISM_ENV_CLUSTER: Record<string, string> = {
  nv: '745772682290/dev-eks-cluster',
  sit: '745772682290/dev-eks-cluster',
  uat: '745772682290/uat-eks-cluster',
  prod: '739187118197/prod-eks-cluster',
};

function normalizeValueFileRef(ref: string): string {
  return ref
    .replace(/^\$helm-values\/?/, '')
    .replace(/^(\.\.\/)+/, '')
    .replace(/^\.\//, '')
    .replace(/\\/g, '/');
}

function clusterMapForBranch(branch?: string | null): Record<string, string> {
  if (branch?.trim().toLowerCase() === SELECTPRISM_BRANCH) {
    return { ...MAIN_BRANCH_ENV_CLUSTER, ...SELECTPRISM_ENV_CLUSTER };
  }
  return MAIN_BRANCH_ENV_CLUSTER;
}

/** First path segment after `values/` — the environment folder name. */
export function parseHelmValuesEnvFromPath(filePath: string): string | null {
  const rel = filePath.replace(/\\/g, '/');
  const match = rel.match(/^values\/([^/]+)\//i);
  return match?.[1]?.toLowerCase() ?? null;
}

/** True for resource-bearing paths under applications/ or tools/. */
export function isHelmValuesResourcePath(filePath: string): boolean {
  const rel = filePath.replace(/\\/g, '/');
  return (
    /^values\/[^/]+\/applications\/[^/]+\/[^/]+\.ya?ml$/i.test(rel) ||
    /^values\/[^/]+\/tools\/[^/]+\.ya?ml$/i.test(rel)
  );
}

/** Resolve registered cluster name for a helm values environment folder. */
export function resolveClusterNameForHelmEnv(
  env: string,
  branch?: string | null
): string | null {
  const key = env.trim().toLowerCase();
  if (!key) return null;
  return clusterMapForBranch(branch)[key] ?? null;
}

/** All environments mapped to the same EKS cluster (exact cluster match only). */
export function listHelmEnvsForCluster(cluster: string, branch?: string | null): string[] {
  const map = clusterMapForBranch(branch);
  const { clusterName } = parseClusterDisplay(cluster);
  return Object.entries(map)
    .filter(([, mapped]) => {
      if (mapped === cluster) return true;
      const exp = parseClusterDisplay(mapped);
      return exp.clusterName === clusterName;
    })
    .map(([env]) => env);
}

/** Whether an ArgoCD app source belongs to the helm values environment folder. */
export function appSourceMatchesHelmEnv(source: HelmAppSourceRef, env: string): boolean {
  const envLower = env.trim().toLowerCase();
  if (!envLower) return true;

  if (source.namespace?.trim().toLowerCase() === envLower) return true;

  return source.helmValueFiles.some((vf) => {
    const norm = normalizeValueFileRef(vf).replace(/\\/g, '/').toLowerCase();
    if (!norm) return false;
    return (
      norm.startsWith(`values/${envLower}/`) ||
      norm.includes(`/values/${envLower}/`) ||
      norm === `values/${envLower}`
    );
  });
}

/** Pick cluster for a git values file change (path env wins over ArgoCD destination). */
export function resolveClusterForGitFileChange(input: {
  filePath: string;
  branch?: string | null;
  fallbackCluster?: string | null;
}): string {
  const env = parseHelmValuesEnvFromPath(input.filePath);
  if (env) {
    const mapped = resolveClusterNameForHelmEnv(env, input.branch);
    if (mapped) return mapped;
  }
  return input.fallbackCluster?.trim() || 'unknown';
}

export function listKnownHelmClusterNames(branch?: string | null): string[] {
  return Array.from(new Set(Object.values(clusterMapForBranch(branch))));
}

/** Registered cluster names may omit account prefix — match by account + cluster suffix. */
export function registeredClusterMatchesExpected(
  registeredName: string,
  expected: string
): boolean {
  if (registeredName === expected) return true;
  const reg = parseClusterDisplay(registeredName);
  const exp = parseClusterDisplay(expected);
  if (reg.clusterName !== exp.clusterName) {
    return registeredName.toLowerCase().includes(exp.clusterName.toLowerCase());
  }
  // Same cluster suffix — require matching account when both sides include one
  if (reg.accountId && exp.accountId) {
    return reg.accountId === exp.accountId;
  }
  return true;
}
