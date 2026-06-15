import prisma from './prisma';
import { decryptSecret, encryptSecret } from './crypto';
import {
  API_TOKEN_GIT_USER,
  WORKSPACE_TOKEN_GIT_USER,
  type BitbucketTokenType,
} from './bitbucket-client';

export const SECRET_PLACEHOLDER = '••••••••';
const CONNECTION_ID = 'default';

export interface BitbucketConnectionView {
  username: string;
  workspace: string | null;
  tokenType: BitbucketTokenType;
  tokenSet: boolean;
  status: 'connected' | 'disconnected' | 'error';
  lastTestAt: string | null;
  lastError: string | null;
  connected: boolean;
}

export interface BitbucketCredentials {
  username: string;
  authUsername?: string | null;
  token: string;
  workspace?: string | null;
  tokenType?: BitbucketTokenType | null;
}

function toView(row: {
  username: string;
  workspace: string | null;
  tokenEnc: string;
  tokenType: string;
  status: string;
  lastTestAt: Date | null;
  lastError: string | null;
  authUsername?: string | null;
}): BitbucketConnectionView {
  return {
    username: row.username,
    workspace: row.workspace,
    tokenType: (row.tokenType as BitbucketTokenType) ?? 'user_api',
    tokenSet: Boolean(row.tokenEnc),
    status: row.status as BitbucketConnectionView['status'],
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    lastError: row.lastError,
    connected: row.status === 'connected' && Boolean(row.tokenEnc),
  };
}

function decryptToken(tokenEnc: string): string {
  if (!tokenEnc) return '';
  try {
    return decryptSecret(tokenEnc);
  } catch {
    return '';
  }
}

export async function getBitbucketConnectionView(): Promise<BitbucketConnectionView | null> {
  const row = await prisma.bitbucketConnection.findUnique({ where: { id: CONNECTION_ID } });
  if (!row) return null;
  return toView(row);
}

export async function getBitbucketCredentials(): Promise<BitbucketCredentials | null> {
  const row = await prisma.bitbucketConnection.findUnique({ where: { id: CONNECTION_ID } });
  if (!row) return null;
  const token = decryptToken(row.tokenEnc);
  if (!token) return null;

  const tokenType = (row.tokenType as BitbucketTokenType) ?? 'user_api';

  if (tokenType === 'workspace_access') {
    if (!row.workspace) return null;
    return {
      username: row.username || row.workspace,
      token,
      authUsername: row.authUsername ?? WORKSPACE_TOKEN_GIT_USER,
      workspace: row.workspace,
      tokenType,
    };
  }

  if (!row.username) return null;
  return {
    username: row.username,
    token,
    authUsername: row.authUsername ?? API_TOKEN_GIT_USER,
    workspace: row.workspace,
    tokenType,
  };
}

export async function upsertBitbucketConnection(input: {
  username: string;
  authUsername?: string | null;
  token?: string;
  tokenType?: BitbucketTokenType;
  workspace?: string | null;
  status?: 'connected' | 'disconnected' | 'error';
  lastError?: string | null;
}): Promise<BitbucketConnectionView> {
  const existing = await prisma.bitbucketConnection.findUnique({ where: { id: CONNECTION_ID } });
  const tokenEnc =
    input.token !== undefined && input.token !== SECRET_PLACEHOLDER
      ? input.token.trim()
        ? encryptSecret(input.token.trim().replace(/\s+/g, ''))
        : ''
      : existing?.tokenEnc ?? '';

  const row = await prisma.bitbucketConnection.upsert({
    where: { id: CONNECTION_ID },
    create: {
      id: CONNECTION_ID,
      username: input.username.trim(),
      authUsername: input.authUsername?.trim() || null,
      tokenEnc,
      tokenType: input.tokenType ?? 'user_api',
      workspace: input.workspace?.trim() || null,
      status: input.status ?? 'disconnected',
      lastError: input.lastError ?? null,
    },
    update: {
      username: input.username.trim(),
      ...(input.authUsername !== undefined
        ? { authUsername: input.authUsername?.trim() || null }
        : {}),
      ...(input.token !== undefined && input.token !== SECRET_PLACEHOLDER ? { tokenEnc } : {}),
      ...(input.tokenType !== undefined ? { tokenType: input.tokenType } : {}),
      ...(input.workspace !== undefined ? { workspace: input.workspace?.trim() || null } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
    },
  });

  return toView(row);
}

export async function markBitbucketConnectionTested(
  ok: boolean,
  error?: string | null
): Promise<void> {
  await prisma.bitbucketConnection.update({
    where: { id: CONNECTION_ID },
    data: {
      status: ok ? 'connected' : 'error',
      lastTestAt: new Date(),
      lastError: ok ? null : error ?? 'Connection test failed',
    },
  });
}

export async function disconnectBitbucket(): Promise<void> {
  await prisma.bitbucketConnection.deleteMany({ where: { id: CONNECTION_ID } });
}

export function buildBitbucketCloneUrl(
  creds: BitbucketCredentials,
  workspace: string,
  repoSlug: string
): string {
  const defaultGitUser =
    creds.tokenType === 'workspace_access' ? WORKSPACE_TOKEN_GIT_USER : API_TOKEN_GIT_USER;
  const gitUser = creds.authUsername?.trim() || defaultGitUser;
  const user = encodeURIComponent(gitUser);
  const token = encodeURIComponent(creds.token.trim().replace(/\s+/g, ''));
  return `https://${user}:${token}@bitbucket.org/${workspace}/${repoSlug}.git`;
}

export function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git$/i, '')
    .replace(/^git@bitbucket\.org:/i, 'https://bitbucket.org/')
    .replace(/^ssh:\/\/git@bitbucket\.org\//i, 'https://bitbucket.org/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function parseBitbucketRepoUrl(url: string): { workspace: string; repoSlug: string } | null {
  const normalized = normalizeRepoUrl(url);
  const match = normalized.match(/bitbucket\.org\/([^/]+)\/([^/]+)$/i);
  if (!match) return null;
  return { workspace: match[1], repoSlug: match[2] };
}

export type { BitbucketTokenType };
