import { parseBitbucketRepoUrl } from '@/lib/bitbucket-connection';

export function sanitizeGitError(message: string): string {
  return message
    .replace(/https?:\/\/[^@\s/]+:[^@\s]+@/gi, 'https://***@')
    .replace(/ATATT[A-Za-z0-9+/=%_-]+/g, '***')
    .replace(/x-bitbucket-api-token-auth:[^@\s]+@/gi, '***@')
    .replace(/x-token-auth:[^@\s]+@/gi, '***@');
}

export function formatRepositoryCloneError(err: unknown, repoUrl: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const message = sanitizeGitError(raw);

  if (/Bitbucket is not connected/i.test(message)) {
    return 'Bitbucket is not connected. Configure it under Admin → Settings before scanning private repositories.';
  }

  if (/403|401|does not exist|do not have access|Authentication failed/i.test(message)) {
    const parsed = parseBitbucketRepoUrl(repoUrl);
    const repoLabel = parsed ? `${parsed.workspace}/${parsed.repoSlug}` : 'repository';
    return `Cannot access ${repoLabel}. Verify the repository URL, Bitbucket connection in Admin → Settings, and that your token has read access to this repo. If the repo is already synced under Git Repositories, try cloning it there first.`;
  }

  if (/timed out|SIGTERM|ETIMEDOUT/i.test(message)) {
    return 'Repository clone timed out. Try again or specify a branch on the resource.';
  }

  const short = message.split('\n').find((line) => line.trim())?.trim() ?? message;
  return `Failed to prepare repository for scanning. ${short.slice(0, 240)}`;
}
