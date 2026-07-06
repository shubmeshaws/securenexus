export type RepoPlatform = 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'gitea' | 'unknown';

export interface RepoSourceContext {
  repoUrl: string;
  defaultBranch?: string | null;
}

export interface FindingSourceInput {
  file: string;
  symlinkFile?: string | null;
  startLine?: number;
  endLine?: number;
  commit?: string | null;
  gitleaksLink?: string | null;
}

function encodePathSegments(filePath: string): string {
  return filePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function normalizeFilePath(file: string): string {
  const normalized = file.replace(/\\/g, '/').trim();
  if (!normalized || normalized === 'unknown') return '';

  const withoutLeading = normalized.replace(/^\.\//, '');
  if (!pathLooksAbsolute(withoutLeading)) return withoutLeading;

  const repoMarker = withoutLeading.match(/(?:^|\/)repo\/(.+)$/i);
  if (repoMarker?.[1]) return repoMarker[1];

  const segments = withoutLeading.split('/');
  const srcIndex = segments.findIndex((segment) =>
    ['src', 'app', 'lib', 'config', 'deploy'].includes(segment.toLowerCase())
  );
  if (srcIndex >= 0) return segments.slice(srcIndex).join('/');

  return withoutLeading;
}

function pathLooksAbsolute(filePath: string): boolean {
  return filePath.startsWith('/') || /^[a-zA-Z]:\//.test(filePath);
}

export function normalizeRepoWebUrl(repoUrl: string): string | null {
  let value = repoUrl.trim();
  if (!value) return null;

  value = value.replace(/^(https?:\/\/)(?:[^@\s/]+@)+/i, '$1');
  value = value.replace(/^git@([^:]+):(.+?)(?:\.git)?$/i, 'https://$1/$2');
  value = value.replace(/^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?$/i, 'https://$1/$2');
  value = value.replace(/\.git$/i, '');
  value = value.replace(/\/+$/, '');

  try {
    const parsed = new URL(value);
    if (!parsed.protocol.startsWith('http')) return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function detectRepoPlatform(repoUrl: string): RepoPlatform {
  const normalized = normalizeRepoWebUrl(repoUrl);
  if (!normalized) return 'unknown';

  try {
    const host = new URL(normalized).hostname.toLowerCase();
    if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
    if (host === 'gitlab.com' || host.includes('gitlab')) return 'gitlab';
    if (host === 'bitbucket.org' || host.includes('bitbucket')) return 'bitbucket';
    if (host === 'dev.azure.com' || host.includes('visualstudio.com')) return 'azure';
    if (host.includes('gitea')) return 'gitea';
  } catch {
    return 'unknown';
  }

  return 'unknown';
}

function resolveBranch(context: RepoSourceContext): string {
  const branch = context.defaultBranch?.trim();
  return branch || 'main';
}

function buildGitHubFileUrl(
  base: string,
  ref: string,
  filePath: string,
  startLine?: number,
  endLine?: number
): string {
  let link = `${base}/blob/${encodeURIComponent(ref)}/${encodePathSegments(filePath)}`;
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'ipynb' || ext === 'md') link += '?plain=1';
  if (startLine && startLine > 0) {
    link += `#L${startLine}`;
    if (endLine && endLine > startLine) link += `-L${endLine}`;
  }
  return link;
}

function buildGitLabFileUrl(
  base: string,
  ref: string,
  filePath: string,
  startLine?: number,
  endLine?: number
): string {
  let link = `${base}/-/blob/${encodeURIComponent(ref)}/${encodePathSegments(filePath)}`;
  if (startLine && startLine > 0) {
    link += `#L${startLine}`;
    if (endLine && endLine > startLine) link += `-${endLine}`;
  }
  return link;
}

function buildBitbucketFileUrl(
  base: string,
  ref: string,
  filePath: string,
  startLine?: number,
  endLine?: number
): string {
  let link = `${base}/src/${encodeURIComponent(ref)}/${encodePathSegments(filePath)}`;
  if (startLine && startLine > 0) {
    link += `#lines-${startLine}`;
    if (endLine && endLine > startLine) link += `:${endLine}`;
  }
  return link;
}

function buildAzureFileUrl(
  base: string,
  ref: string,
  filePath: string,
  startLine?: number,
  endLine?: number
): string {
  let link = `${base}/commit/${encodeURIComponent(ref)}?path=/${encodePathSegments(filePath)}`;
  if (startLine && startLine > 0) {
    link += `&line=${startLine}`;
    if (endLine && endLine > startLine) link += `&lineEnd=${endLine}`;
  }
  link += '&lineStartColumn=1&lineEndColumn=10000000&type=2&lineStyle=plain&_a=files';
  return link;
}

function buildGiteaFileUrl(
  base: string,
  ref: string,
  filePath: string,
  startLine?: number,
  endLine?: number
): string {
  let link = `${base}/src/commit/${encodeURIComponent(ref)}/${encodePathSegments(filePath)}`;
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'ipynb' || ext === 'md') link += '?display=source';
  if (startLine && startLine > 0) {
    link += `#L${startLine}`;
    if (endLine && endLine > startLine) link += `-L${endLine}`;
  }
  return link;
}

function buildPlatformFileUrl(
  platform: RepoPlatform,
  base: string,
  ref: string,
  filePath: string,
  startLine?: number,
  endLine?: number
): string | null {
  switch (platform) {
    case 'github':
      return buildGitHubFileUrl(base, ref, filePath, startLine, endLine);
    case 'gitlab':
      return buildGitLabFileUrl(base, ref, filePath, startLine, endLine);
    case 'bitbucket':
      return buildBitbucketFileUrl(base, ref, filePath, startLine, endLine);
    case 'azure':
      return buildAzureFileUrl(base, ref, filePath, startLine, endLine);
    case 'gitea':
      return buildGiteaFileUrl(base, ref, filePath, startLine, endLine);
    default:
      return null;
  }
}

function addUrl(urls: string[], seen: Set<string>, url: string | null | undefined): void {
  const trimmed = url?.trim();
  if (!trimmed || seen.has(trimmed)) return;
  seen.add(trimmed);
  urls.push(trimmed);
}

export function buildFindingSourceUrls(
  context: RepoSourceContext | null | undefined,
  input: FindingSourceInput
): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  addUrl(urls, seen, input.gitleaksLink);

  const repoBase = context?.repoUrl ? normalizeRepoWebUrl(context.repoUrl) : null;
  const platform = repoBase ? detectRepoPlatform(repoBase) : 'unknown';
  const branch = context ? resolveBranch(context) : 'main';
  const commit = input.commit?.trim() || null;

  const filePaths = [normalizeFilePath(input.file)];
  const symlink = input.symlinkFile?.trim();
  if (symlink) {
    const normalizedSymlink = normalizeFilePath(symlink);
    if (normalizedSymlink && !filePaths.includes(normalizedSymlink)) {
      filePaths.push(normalizedSymlink);
    }
  }

  if (!repoBase) return urls;

  for (const filePath of filePaths) {
    if (!filePath) continue;

    if (commit) {
      addUrl(
        urls,
        seen,
        buildPlatformFileUrl(platform, repoBase, commit, filePath, input.startLine, input.endLine)
      );
    }

    if (branch) {
      addUrl(
        urls,
        seen,
        buildPlatformFileUrl(platform, repoBase, branch, filePath, input.startLine, input.endLine)
      );
    }
  }

  return urls;
}
