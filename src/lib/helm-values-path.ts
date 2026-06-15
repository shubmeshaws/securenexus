import {
  parseHelmValuesEnvFromPath,
  appSourceMatchesHelmEnv,
  isHelmValuesResourcePath,
  type HelmAppSourceRef,
} from './helm-env-cluster';

export interface InferredHelmApp {
  env: string;
  namespace: string;
  /** YAML file stem — used as the application / values file name in the UI. */
  argocdApp: string;
  yamlFileName: string;
  filePath: string;
  /** Legacy deployment name for kubectl lookup (e.g. pfpt-rms-backend-server). */
  legacyDeploymentName: string;
}

export function yamlFileNameFromPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
}

export function yamlStemFromPath(filePath: string): string {
  return yamlFileNameFromPath(filePath).replace(/\.ya?ml$/i, '');
}

/**
 * Infer app metadata from helm-charts values path.
 *
 * Layout:
 *   values/{env}/applications/{group}/{service}.yaml
 *   values/{env}/tools/{tool}.yaml
 *
 * Application name in UI = YAML filename (e.g. backend-server.yaml).
 */
export function inferAppFromHelmValuesPath(filePath: string): InferredHelmApp | null {
  if (!isHelmValuesResourcePath(filePath)) return null;

  const rel = filePath.replace(/\\/g, '/');
  const yamlFileName = yamlFileNameFromPath(rel);
  const yamlStem = yamlStemFromPath(rel);

  const appMatch = rel.match(/^values\/([^/]+)\/applications\/([^/]+)\/([^/]+)\.ya?ml$/i);
  if (appMatch) {
    const env = appMatch[1].toLowerCase();
    const group = appMatch[2].toLowerCase();
    return {
      env,
      namespace: `${env}-${group}`,
      argocdApp: yamlStem,
      yamlFileName,
      filePath: rel,
      legacyDeploymentName: `${env}-${group}-${yamlStem}`,
    };
  }

  const toolsMatch = rel.match(/^values\/([^/]+)\/tools\/([^/]+)\.ya?ml$/i);
  if (toolsMatch) {
    const env = toolsMatch[1].toLowerCase();
    return {
      env,
      namespace: env,
      argocdApp: yamlStem,
      yamlFileName,
      filePath: rel,
      legacyDeploymentName: `${env}-${yamlStem}`,
    };
  }

  return null;
}

export function helmEnvsFromChangedFiles(filePaths: string[]): Set<string> {
  const envs = new Set<string>();
  for (const filePath of filePaths) {
    const env = parseHelmValuesEnvFromPath(filePath);
    if (env) envs.add(env);
  }
  return envs;
}

export function appBelongsToHelmEnv(
  app: HelmAppSourceRef & { argocdApp?: string | null },
  env: string
): boolean {
  if (appSourceMatchesHelmEnv(app, env)) return true;

  const envLower = env.toLowerCase();
  const ns = app.namespace?.trim().toLowerCase() ?? '';
  if (ns === envLower || ns.startsWith(`${envLower}-`)) return true;

  const name = app.argocdApp?.trim().toLowerCase() ?? '';
  if (name.startsWith(`${envLower}-`) || name === envLower) return true;

  return false;
}

export function appBelongsToAnyHelmEnv(
  app: HelmAppSourceRef & { argocdApp?: string | null },
  envs: Iterable<string>
): boolean {
  for (const env of Array.from(envs)) {
    if (appBelongsToHelmEnv(app, env)) return true;
  }
  return false;
}

function safeRowString(value: unknown): string {
  return typeof value === 'string' ? value : value != null ? String(value) : '';
}

/** Full repo path if stored on workload, otherwise reconstruct display name. */
export function valuesFilePathFromRow(row: {
  workload?: string | null;
  argocdApp?: string | null;
}): string | null {
  const workload = safeRowString(row.workload);
  if (workload.replace(/\\/g, '/').startsWith('values/')) return workload.replace(/\\/g, '/');
  return null;
}

export function valuesFileLabelFromRow(row: {
  workload?: string | null;
  argocdApp?: string | null;
}): string {
  const path = valuesFilePathFromRow(row);
  if (path) return yamlFileNameFromPath(path);
  const argocdApp = safeRowString(row.argocdApp);
  if (!argocdApp) return '—';
  return argocdApp.includes('.yaml') ? argocdApp : `${argocdApp}.yaml`;
}

/** Strip `{env}-` prefix and `.yaml` from values filename → e.g. rms-backend-server. */
export function applicationNameFromYamlFileName(
  yamlFileName: string,
  env?: string | null
): string {
  const stem = yamlFileName.replace(/\.ya?ml$/i, '');
  const envLower = env?.trim().toLowerCase();
  if (envLower) {
    const prefix = `${envLower}-`;
    if (stem.toLowerCase().startsWith(prefix)) {
      return stem.slice(prefix.length);
    }
  }
  return stem;
}

/** Reconstruct values file path from legacy workload + namespace when needed. */
export function normalizedValuesPathFromRow(row: {
  workload?: string | null;
  namespace?: string | null;
  argocdApp?: string | null;
}): string | null {
  const direct = valuesFilePathFromRow(row);
  if (direct) return direct;

  const namespace = safeRowString(row.namespace).toLowerCase();
  const workload = safeRowString(row.workload);
  if (!namespace || !workload || workload === '*' || workload === 'base' || workload === 'global') {
    return null;
  }

  const dash = namespace.indexOf('-');
  if (dash > 0) {
    const env = namespace.slice(0, dash);
    const group = namespace.slice(dash + 1);
    if (env && group) {
      return `values/${env}/applications/${group}/${workload}.yaml`;
    }
  }

  return `values/${namespace}/tools/${workload}.yaml`;
}

/** Stable merge key for grouping CPU/memory changes from the same commit + values file. */
export function auditRowGroupKey(row: {
  cluster: string;
  revisionSha: string;
  namespace?: string | null;
  workload?: string | null;
  argocdApp?: string | null;
  containerName?: string | null;
}): string {
  const valuesPath = normalizedValuesPathFromRow(row);
  const appKey =
    valuesPath ??
    `legacy:${safeRowString(row.namespace)}:${safeRowString(row.workload) || safeRowString(row.argocdApp)}`;
  const container = safeRowString(row.containerName) || 'default';
  return `${row.cluster}::${row.revisionSha}::${appKey}::${container}`;
}

/** Application name for table column (group-service or env-stripped yaml name). */
export function applicationNameFromRow(row: {
  workload?: string | null;
  argocdApp?: string | null;
  environment?: string | null;
  namespace?: string | null;
}): string {
  const argocdApp = safeRowString(row.argocdApp);
  const path = valuesFilePathFromRow(row);
  if (path) {
    const appMatch = path.match(/^values\/([^/]+)\/applications\/([^/]+)\/([^/]+)\.ya?ml$/i);
    if (appMatch) {
      const group = appMatch[2].toLowerCase();
      const service = appMatch[3].replace(/\.ya?ml$/i, '').toLowerCase();
      return `${group}-${service}`;
    }
    const env = parseHelmValuesEnvFromPath(path);
    return applicationNameFromYamlFileName(yamlFileNameFromPath(path), env);
  }

  const env =
    row.environment?.trim().toLowerCase() ||
    row.namespace?.split('-')[0]?.toLowerCase() ||
    null;
  if (!argocdApp) return '—';
  return applicationNameFromYamlFileName(valuesFileLabelFromRow(row), env);
}

/** Workload/container label for resource column (not the values file path). */
export function resourceWorkloadLabelFromRow(row: {
  workload?: string | null;
  argocdApp?: string | null;
  containerName?: string | null;
}): string | null {
  const workload = safeRowString(row.workload);
  const argocdApp = safeRowString(row.argocdApp);
  const path = valuesFilePathFromRow(row);
  if (path) {
    if (
      row.containerName &&
      row.containerName !== '__replicas__' &&
      row.containerName !== '__git_sync__'
    ) {
      return row.containerName;
    }
    return yamlStemFromPath(path);
  }

  if (
    workload &&
    workload !== '*' &&
    workload !== 'base' &&
    workload !== 'global' &&
    !workload.replace(/\\/g, '/').startsWith('values/')
  ) {
    return workload;
  }

  if (
    row.containerName &&
    row.containerName !== '__replicas__' &&
    row.containerName !== '__git_sync__'
  ) {
    return row.containerName;
  }

  return argocdApp || null;
}

export function deploymentLabelFromRow(row: {
  workload?: string | null;
  argocdApp?: string | null;
}): string {
  const workload = safeRowString(row.workload);
  const argocdApp = safeRowString(row.argocdApp);
  if (workload.replace(/\\/g, '/').startsWith('values/')) return argocdApp || '—';
  if (workload === '*' || !workload) return argocdApp || '—';
  return workload;
}
