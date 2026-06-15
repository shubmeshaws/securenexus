import type { BitbucketCredentials } from './bitbucket-connection';

export type BitbucketTokenType = 'user_api' | 'workspace_access';

export interface BitbucketTestResult {
  ok: boolean;
  message: string;
  displayName?: string;
  workspace?: string;
  authUsername?: string;
  tokenType?: BitbucketTokenType;
}

export interface BitbucketRepoSummary {
  name: string;
  slug: string;
  workspace: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
}

export const API_TOKEN_GIT_USER = 'x-bitbucket-api-token-auth';
export const WORKSPACE_TOKEN_GIT_USER = 'x-token-auth';

function normalizeToken(token: string): string {
  return token.trim().replace(/\s+/g, '');
}

function authHeader(username: string, token: string): string {
  const encoded = Buffer.from(`${username}:${token}`).toString('base64');
  return `Basic ${encoded}`;
}

async function bitbucketBasicFetch(
  url: string,
  username: string,
  token: string
): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: authHeader(username, token),
      Accept: 'application/json',
    },
  });
}

async function bitbucketBearerFetch(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
}

function basicAuthCandidates(username: string): string[] {
  const trimmed = username.trim();
  return Array.from(new Set([trimmed, API_TOKEN_GIT_USER].filter(Boolean)));
}

async function testUserApiToken(
  username: string,
  token: string,
  workspace?: string | null
): Promise<BitbucketTestResult> {
  if (!username.includes('@')) {
    return {
      ok: false,
      message:
        'User API tokens require your Atlassian account email (must contain @). Find it under Bitbucket → Personal settings → Email aliases. Do not use your Bitbucket username here.',
    };
  }

  let lastDetail = 'Invalid credentials';
  for (const candidate of basicAuthCandidates(username)) {
    const res = await bitbucketBasicFetch('https://api.bitbucket.org/2.0/user', candidate, token);
    if (res.ok) {
      const data = (await res.json()) as { display_name?: string; username?: string };
      const authUsername = candidate === username ? API_TOKEN_GIT_USER : candidate;

      if (workspace) {
        const wsRes = await bitbucketBasicFetch(
          `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}?pagelen=1`,
          candidate,
          token
        );
        if (!wsRes.ok) {
          const text = await wsRes.text();
          return {
            ok: false,
            message: `Authenticated as ${data.display_name ?? data.username}, but workspace "${workspace}" is not accessible (${wsRes.status}): ${text.slice(0, 120)}. Ensure the token has read:repository:bitbucket scope.`,
            displayName: data.display_name ?? data.username,
            authUsername,
            tokenType: 'user_api',
          };
        }
      }

      return {
        ok: true,
        message: workspace
          ? `Connected with user API token as ${data.display_name ?? data.username} (workspace: ${workspace})`
          : `Connected with user API token as ${data.display_name ?? data.username}`,
        displayName: data.display_name ?? data.username,
        workspace: workspace ?? undefined,
        authUsername,
        tokenType: 'user_api',
      };
    }

    const text = await res.text();
    lastDetail = text.slice(0, 200) || `HTTP ${res.status}`;
    if (res.status !== 401) break;
  }

  return {
    ok: false,
    message: `User API token rejected (401): ${lastDetail}. Use your Atlassian email + API token with scopes: read:user:bitbucket, read:repository:bitbucket.`,
    tokenType: 'user_api',
  };
}

async function testWorkspaceAccessToken(
  token: string,
  workspace: string
): Promise<BitbucketTestResult> {
  const url = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}?pagelen=1`;
  const res = await bitbucketBearerFetch(url, token);
  if (!res.ok) {
    const text = await res.text();
    return {
      ok: false,
      message: `Workspace access token rejected (${res.status}): ${text.slice(0, 200)}. Use Bearer auth with a workspace access token that has repository read scope.`,
      tokenType: 'workspace_access',
    };
  }

  const data = (await res.json()) as { values?: unknown[] };
  const repoCount = data.values?.length ?? 0;

  return {
    ok: true,
    message: `Connected with workspace access token to "${workspace}" (${repoCount > 0 ? 'repositories accessible' : 'workspace reachable'})`,
    workspace,
    authUsername: WORKSPACE_TOKEN_GIT_USER,
    tokenType: 'workspace_access',
    displayName: `workspace:${workspace}`,
  };
}

async function autoDetectToken(
  username: string,
  token: string,
  workspace?: string | null
): Promise<BitbucketTestResult> {
  if (username.includes('@')) {
    const userResult = await testUserApiToken(username, token, workspace);
    if (userResult.ok) return userResult;
  }

  if (workspace) {
    const wsResult = await testWorkspaceAccessToken(token, workspace);
    if (wsResult.ok) return wsResult;
  }

  const bearerUser = await bitbucketBearerFetch('https://api.bitbucket.org/2.0/user', token);
  if (bearerUser.ok) {
    const data = (await bearerUser.json()) as { display_name?: string; username?: string };
    return {
      ok: true,
      message: `Connected with bearer token as ${data.display_name ?? data.username}`,
      displayName: data.display_name ?? data.username,
      authUsername: WORKSPACE_TOKEN_GIT_USER,
      tokenType: 'workspace_access',
      workspace: workspace ?? undefined,
    };
  }

  if (username.includes('@')) {
    return testUserApiToken(username, token, workspace);
  }

  return {
    ok: false,
    message:
      'Could not authenticate. For user API tokens: enter your Atlassian account email (not Bitbucket username) + API token. For workspace access tokens: select that type, enter workspace slug + token.',
  };
}

export async function testBitbucketConnection(
  creds: BitbucketCredentials
): Promise<BitbucketTestResult> {
  const token = normalizeToken(creds.token ?? '');
  const username = creds.username?.trim() ?? '';
  const workspace = creds.workspace?.trim() || null;
  const tokenType = creds.tokenType ?? 'user_api';

  if (!token) {
    return { ok: false, message: 'API token is required' };
  }

  if (tokenType === 'workspace_access') {
    if (!workspace) {
      return {
        ok: false,
        message: 'Workspace slug is required for workspace access tokens (e.g. my-workspace from bitbucket.org/my-workspace).',
      };
    }
    try {
      return await testWorkspaceAccessToken(token, workspace);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reach Bitbucket';
      return { ok: false, message };
    }
  }

  if (!username) {
    return {
      ok: false,
      message: 'Atlassian account email is required for user API tokens.',
    };
  }

  try {
    if (tokenType === 'user_api') {
      return await testUserApiToken(username, token, workspace);
    }
    return await autoDetectToken(username, token, workspace);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to reach Bitbucket';
    return { ok: false, message };
  }
}

export async function bitbucketApiFetch(
  url: string,
  creds: BitbucketCredentials & { authUsername?: string | null; tokenType?: BitbucketTokenType | null }
): Promise<Response> {
  const token = normalizeToken(creds.token);
  if (creds.tokenType === 'workspace_access') {
    return bitbucketBearerFetch(url, token);
  }

  const authUser = creds.authUsername?.trim() || creds.username;
  return bitbucketBasicFetch(url, authUser, token);
}

export async function listBitbucketRepositories(
  creds: BitbucketCredentials & {
    authUsername?: string | null;
    tokenType?: BitbucketTokenType | null;
  },
  workspace: string
): Promise<BitbucketRepoSummary[]> {
  const repos: BitbucketRepoSummary[] = [];
  let url: string | null =
    `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}?pagelen=100`;

  while (url) {
    const res = await bitbucketApiFetch(url, creds);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to list Bitbucket repos (${res.status}): ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      values?: Array<{
        name?: string;
        slug?: string;
        full_name?: string;
        links?: { clone?: Array<{ name: string; href: string }> };
        mainbranch?: { name?: string };
      }>;
      next?: string;
    };

    for (const row of data.values ?? []) {
      const slug = row.slug ?? '';
      const ws = workspace;
      const httpsClone =
        row.links?.clone?.find((c) => c.name === 'https')?.href ??
        `https://bitbucket.org/${ws}/${slug}.git`;
      repos.push({
        name: row.name ?? slug,
        slug,
        workspace: ws,
        fullName: row.full_name ?? `${ws}/${slug}`,
        cloneUrl: httpsClone,
        defaultBranch: row.mainbranch?.name ?? 'main',
      });
    }

    url = data.next ?? null;
  }

  return repos;
}
