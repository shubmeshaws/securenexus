import { spawnSync } from 'child_process';
import * as k8s from '@kubernetes/client-node';
import type { AwsCredentials } from './aws-settings';
import { resolveEffectiveCredentials } from './aws-credential-store';
import { parseClusterDisplay } from './utils';
import prisma from './prisma';

function extractClusterTlsFromKubeconfig(
  kubeconfigB64: string,
  contextName: string
): { server: string; caData?: string } | null {
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromString(Buffer.from(kubeconfigB64, 'base64').toString('utf-8'));

    const contexts = kc.getContexts().filter((ctx) => Boolean(ctx.name));
    const match =
      contexts.find((ctx) => ctx.name === contextName) ??
      contexts.find((ctx) => ctx.name?.includes(contextName)) ??
      contexts[0];
    if (!match?.name) return null;

    kc.setCurrentContext(match.name);
    const cluster = kc.getCurrentCluster();
    if (!cluster?.server) return null;

    return { server: cluster.server, caData: cluster.caData };
  } catch {
    return null;
  }
}

const TOKEN_CACHE_TTL_MS = 14 * 60 * 1000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function tokenCacheKey(eksClusterName: string, region: string, creds: AwsCredentials): string {
  return `${eksClusterName}:${region}:${creds.accessKeyId}:${creds.sessionToken ?? ''}`;
}

function getCachedEksToken(
  eksClusterName: string,
  region: string,
  creds: AwsCredentials
): string | null {
  const key = tokenCacheKey(eksClusterName, region, creds);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  tokenCache.delete(key);
  return null;
}

function cacheEksToken(
  eksClusterName: string,
  region: string,
  creds: AwsCredentials,
  token: string
): void {
  const key = tokenCacheKey(eksClusterName, region, creds);
  tokenCache.set(key, { token, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS });
}

function getEksTokenViaAwsCli(
  eksClusterName: string,
  region: string,
  creds: AwsCredentials
): string {
  const result = spawnSync(
    'aws',
    ['eks', 'get-token', '--cluster-name', eksClusterName, '--region', region, '--output', 'json'],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: creds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
        ...(creds.sessionToken ? { AWS_SESSION_TOKEN: creds.sessionToken } : {}),
        AWS_DEFAULT_REGION: region,
      },
    }
  );

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || 'aws eks get-token failed');
  }

  const parsed = JSON.parse(result.stdout) as { status?: { token?: string } };
  const token = parsed.status?.token?.trim();
  if (!token) throw new Error('aws eks get-token returned no token');
  return token;
}

export async function resolveAwsCredentialForAccount(
  accountId: string
): Promise<{ credentials: AwsCredentials; credentialId: string } | null> {
  const row = await prisma.awsCredential.findFirst({
    where: { awsAccountId: accountId },
    orderBy: { updatedAt: 'desc' },
  });
  if (!row) return null;

  const { credentials } = await resolveEffectiveCredentials(row.id);
  return { credentials, credentialId: row.id };
}

/** Build a kubeconfig using SecureNexus AWS Integration creds for the cluster account. */
export async function buildEksKubeConfigForRegisteredCluster(input: {
  registeredName: string;
  contextName: string | null;
  kubeconfigB64: string | null;
  region: string | null;
}): Promise<k8s.KubeConfig | null> {
  const { accountId, clusterName: eksClusterName } = parseClusterDisplay(input.registeredName);
  if (!accountId || !eksClusterName) return null;

  const resolved = await resolveAwsCredentialForAccount(accountId);
  if (!resolved) return null;

  const region =
    input.region?.trim() ||
    resolved.credentials.defaultRegion ||
    process.env.AWS_DEFAULT_REGION ||
    'ap-south-1';

  const token = getCachedEksToken(eksClusterName, region, resolved.credentials) ??
    getEksTokenViaAwsCli(eksClusterName, region, resolved.credentials);
  cacheEksToken(eksClusterName, region, resolved.credentials, token);

  let server: string | null = null;
  let caData: string | undefined;

  if (input.kubeconfigB64) {
    const tls = extractClusterTlsFromKubeconfig(
      input.kubeconfigB64,
      input.contextName ?? input.registeredName
    );
    if (tls) {
      server = tls.server;
      caData = tls.caData;
    }
  }

  if (!server) {
    const { EKSClient, DescribeClusterCommand } = await import('@aws-sdk/client-eks');
    const eks = new EKSClient({
      region,
      credentials: {
        accessKeyId: resolved.credentials.accessKeyId,
        secretAccessKey: resolved.credentials.secretAccessKey,
        ...(resolved.credentials.sessionToken
          ? { sessionToken: resolved.credentials.sessionToken }
          : {}),
      },
    });
    const described = await eks.send(new DescribeClusterCommand({ name: eksClusterName }));
    server = described.cluster?.endpoint ?? null;
    caData = described.cluster?.certificateAuthority?.data ?? undefined;
  }

  if (!server) return null;

  const kc = new k8s.KubeConfig();
  const context = input.contextName ?? input.registeredName;
  kc.loadFromOptions({
    clusters: [{ name: 'cluster', server, caData, skipTLSVerify: !caData }],
    users: [{ name: 'eks-user', token }],
    contexts: [{ name: context, cluster: 'cluster', user: 'eks-user' }],
    currentContext: context,
  });
  return kc;
}
