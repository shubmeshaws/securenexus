import { parseHelmValuesEnvFromPath, appSourceMatchesHelmEnv } from './helm-env-cluster';

/** Normalize ArgoCD helm valueFiles refs to a repo-relative path. */
export function normalizeHelmValueFileRef(ref: string): string {
  return ref
    .replace(/^\$helm-values\/?/, '')
    .replace(/^(\.\.\/)+/, '')
    .replace(/^\.\//, '')
    .replace(/\\/g, '/');
}

export interface AppSourceMatchInput {
  argocdApp: string;
  gitRepositoryId: string | null;
  repoPath: string | null;
  helmValueFiles: string[];
  cluster?: string | null;
  namespace?: string | null;
  targetRevision?: string | null;
}

function fileMatchesRepoPath(
  filePath: string,
  repoPath: string | null | undefined,
  helmValueFiles: string[]
): boolean {
  const rel = filePath.replace(/\\/g, '/');

  if (repoPath) {
    const prefix = repoPath.replace(/^\.\/?/, '').replace(/\/+$/, '');
    if (prefix && (rel === prefix || rel.startsWith(`${prefix}/`))) {
      return true;
    }
  }

  return helmValueFiles.some((vf) => {
    const v = normalizeHelmValueFileRef(vf);
    if (!v || v === 'values.yaml') return false;
    return rel === v;
  });
}

/** Map a git diff file to ArgoCD apps (supports values in a separate repo from the chart). */
export function findAppSourcesForGitFile(
  filePath: string,
  gitRepositoryId: string,
  sources: AppSourceMatchInput[]
): AppSourceMatchInput[] {
  const rel = filePath.replace(/\\/g, '/');
  const matches: AppSourceMatchInput[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    const valueFileMatch = source.helmValueFiles.some((vf) => {
      const norm = normalizeHelmValueFileRef(vf);
      return norm === rel;
    });
    if (valueFileMatch) {
      if (!seen.has(source.argocdApp)) {
        seen.add(source.argocdApp);
        matches.push(source);
      }
      continue;
    }

    if (source.gitRepositoryId === gitRepositoryId) {
      if (fileMatchesRepoPath(rel, source.repoPath, source.helmValueFiles)) {
        if (!seen.has(source.argocdApp)) {
          seen.add(source.argocdApp);
          matches.push(source);
        }
      }
    }
  }

  const envFromPath = parseHelmValuesEnvFromPath(rel);
  if (envFromPath) {
    return matches.filter((source) => appSourceMatchesHelmEnv(source, envFromPath));
  }

  return matches;
}
