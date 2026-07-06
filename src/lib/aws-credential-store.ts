import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  type Instance,
} from '@aws-sdk/client-ec2';
import { EKSClient, ListClustersCommand } from '@aws-sdk/client-eks';
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from '@aws-sdk/client-sts';
import prisma from './prisma';
import { encryptSecret, decryptSecret } from './crypto';
import { getSetting, SETTING_KEYS } from './settings';
import type { AwsConnectionTestResult, AwsCredentials, IamPolicyDocument } from './aws-settings';

export const SECRET_PLACEHOLDER = '••••••••';

export interface AwsCredentialView {
  id: string;
  name: string;
  accessKeyId: string;
  secretAccessKeySet: boolean;
  defaultRegion: string;
  awsAccountId: string | null;
  iamUsername: string | null;
  iamRoleName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Ec2InstanceSummary {
  instanceId: string;
  name: string;
  region: string;
  state: string;
  instanceType: string;
}

function iamUsernameFromArn(arn?: string | null): string | null {
  if (!arn) return null;
  const userMatch = arn.match(/\/user\/(.+)$/);
  if (userMatch?.[1]) return userMatch[1];
  const roleMatch = arn.match(/\/role\/(.+)$/);
  if (roleMatch?.[1]) return roleMatch[1];
  const segment = arn.split('/').pop();
  return segment?.trim() || null;
}

function normalizeRegion(region: string): string {
  return region.trim() || 'ap-south-1';
}

function clientsFor(credentials: AwsCredentials) {
  const region = normalizeRegion(credentials.defaultRegion);
  const config = {
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
  };
  return {
    sts: new STSClient(config),
    eks: new EKSClient(config),
    ec2: (r: string) => new EC2Client({ ...config, region: r }),
    region,
  };
}

function buildRoleArn(roleNameOrArn: string, accountId: string): string {
  const trimmed = roleNameOrArn.trim();
  if (trimmed.startsWith('arn:aws:iam::')) return trimmed;
  if (trimmed.startsWith('role/')) return `arn:aws:iam::${accountId}:${trimmed}`;
  return `arn:aws:iam::${accountId}:role/${trimmed}`;
}

async function callerAccountId(credentials: AwsCredentials): Promise<string | null> {
  try {
    const { sts } = clientsFor(credentials);
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    return identity.Account ?? null;
  } catch {
    return null;
  }
}

async function assumeRoleIfConfigured(
  base: AwsCredentials,
  opts: { iamRoleName?: string | null; awsAccountId?: string | null; sessionLabel: string }
): Promise<AwsCredentials> {
  const roleSpec = opts.iamRoleName?.trim();
  if (!roleSpec) return base;

  const sts = new STSClient({
    region: base.defaultRegion,
    credentials: {
      accessKeyId: base.accessKeyId,
      secretAccessKey: base.secretAccessKey,
    },
  });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const accountId = opts.awsAccountId || identity.Account;
  if (!accountId) throw new Error('Unable to resolve AWS account ID for role assumption');

  const roleArn = buildRoleArn(roleSpec, accountId);
  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: opts.sessionLabel.replace(/[^\w+=,.@-]/g, '-').slice(0, 32),
      DurationSeconds: 3600,
    })
  );

  const c = assumed.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new Error('Failed to assume IAM role — incomplete credentials returned');
  }

  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    defaultRegion: base.defaultRegion,
  };
}

export async function resolveEffectiveCredentials(
  credentialId: string
): Promise<{ credentials: AwsCredentials; awsAccountId: string | null }> {
  const row = await prisma.awsCredential.findUnique({ where: { id: credentialId } });
  const base = await resolveAwsCredentials(credentialId);
  if (!row || !base) throw new Error('AWS credentials not found');

  const credentials = await assumeRoleIfConfigured(base, {
    iamRoleName: row.iamRoleName,
    awsAccountId: row.awsAccountId,
    sessionLabel: `SecureNexus-${row.name}`,
  });
  const awsAccountId = (await callerAccountId(credentials)) ?? row.awsAccountId;
  return { credentials, awsAccountId };
}

function toView(row: {
  id: string;
  name: string;
  accessKeyId: string;
  secretAccessKey: string;
  defaultRegion: string;
  awsAccountId: string | null;
  iamUsername: string | null;
  iamRoleName: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AwsCredentialView {
  return {
    id: row.id,
    name: row.name,
    accessKeyId: row.accessKeyId,
    secretAccessKeySet: Boolean(row.secretAccessKey),
    defaultRegion: normalizeRegion(row.defaultRegion),
    awsAccountId: row.awsAccountId,
    iamUsername: row.iamUsername,
    iamRoleName: row.iamRoleName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function resolveIamUsername(credentials: AwsCredentials): Promise<string | null> {
  try {
    const { sts } = clientsFor(credentials);
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    return iamUsernameFromArn(identity.Arn ?? null);
  } catch {
    return null;
  }
}

export async function migrateLegacyAwsCredentials(): Promise<void> {
  const count = await prisma.awsCredential.count();
  if (count > 0) return;

  const accessKeyId = (await getSetting(SETTING_KEYS.AWS_ACCESS_KEY_ID))?.trim() ?? '';
  const secretEnc = await getSetting(SETTING_KEYS.AWS_SECRET_ACCESS_KEY);
  const defaultRegion =
    (await getSetting(SETTING_KEYS.AWS_DEFAULT_REGION))?.trim() || 'ap-south-1';
  const iamUsername = (await getSetting(SETTING_KEYS.AWS_IAM_USERNAME))?.trim() || null;

  if (!accessKeyId || !secretEnc) return;

  await prisma.awsCredential.create({
    data: {
      name: 'Default',
      accessKeyId,
      secretAccessKey: secretEnc,
      defaultRegion: normalizeRegion(defaultRegion),
      iamUsername,
    },
  });
}

export async function listAwsCredentials(): Promise<AwsCredentialView[]> {
  await migrateLegacyAwsCredentials();
  const rows = await prisma.awsCredential.findMany({ orderBy: { name: 'asc' } });

  const enriched = await Promise.all(
    rows.map(async (row) => {
      if (row.awsAccountId) return row;
      try {
        const { awsAccountId } = await resolveEffectiveCredentials(row.id);
        if (awsAccountId) {
          return prisma.awsCredential.update({
            where: { id: row.id },
            data: { awsAccountId },
          });
        }
      } catch {
        // leave unchanged
      }
      return row;
    })
  );

  return enriched.map(toView);
}

export async function getAwsCredentialView(id: string): Promise<AwsCredentialView | null> {
  await migrateLegacyAwsCredentials();
  const row = await prisma.awsCredential.findUnique({ where: { id } });
  return row ? toView(row) : null;
}

export async function resolveAwsCredentials(id?: string | null): Promise<AwsCredentials | null> {
  await migrateLegacyAwsCredentials();

  const row = id
    ? await prisma.awsCredential.findUnique({ where: { id } })
    : await prisma.awsCredential.findFirst({ orderBy: { createdAt: 'asc' } });

  if (!row) return null;

  try {
    return {
      accessKeyId: row.accessKeyId,
      secretAccessKey: decryptSecret(row.secretAccessKey),
      defaultRegion: normalizeRegion(row.defaultRegion),
    };
  } catch {
    return null;
  }
}

export async function resolveAwsCredentialsForInput(
  id: string,
  input: {
    accessKeyId?: string;
    secretAccessKey?: string;
    defaultRegion?: string;
    iamRoleName?: string | null;
    awsAccountId?: string | null;
    name?: string;
  }
): Promise<AwsCredentials | null> {
  const stored = await resolveAwsCredentials(id);
  const row = await prisma.awsCredential.findUnique({ where: { id } });
  const accessKeyId = input.accessKeyId?.trim() || stored?.accessKeyId || '';
  let secretAccessKey = input.secretAccessKey?.trim() ?? '';
  if (!secretAccessKey || secretAccessKey === SECRET_PLACEHOLDER) {
    secretAccessKey = stored?.secretAccessKey ?? '';
  }
  const defaultRegion = normalizeRegion(
    input.defaultRegion ?? stored?.defaultRegion ?? 'ap-south-1'
  );

  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey, defaultRegion };
}

export async function createAwsCredential(
  input: {
    name: string;
    accessKeyId: string;
    secretAccessKey: string;
    defaultRegion: string;
    iamRoleName?: string | null;
  },
  updatedBy?: string
): Promise<AwsCredentialView> {
  const name = input.name.trim();
  const accessKeyId = input.accessKeyId.trim();
  const secretAccessKey = input.secretAccessKey.trim();
  const iamRoleName = input.iamRoleName?.trim() || null;
  if (!name) throw new Error('Account name is required');
  if (!accessKeyId) throw new Error('AWS access key ID is required');
  if (!secretAccessKey) throw new Error('AWS secret access key is required');

  const base: AwsCredentials = {
    accessKeyId,
    secretAccessKey,
    defaultRegion: normalizeRegion(input.defaultRegion),
  };
  const effective = await assumeRoleIfConfigured(base, {
    iamRoleName,
    awsAccountId: null,
    sessionLabel: `SecureNexus-${name}`,
  });
  const iamUsername = await resolveIamUsername(effective);
  const awsAccountId = await callerAccountId(effective);

  const row = await prisma.awsCredential.create({
    data: {
      name,
      accessKeyId,
      secretAccessKey: encryptSecret(secretAccessKey),
      defaultRegion: base.defaultRegion,
      awsAccountId,
      iamUsername,
      iamRoleName,
      updatedBy,
    },
  });

  return toView(row);
}

export async function updateAwsCredential(
  id: string,
  input: {
    name?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    defaultRegion?: string;
    iamRoleName?: string | null;
  },
  updatedBy?: string
): Promise<AwsCredentialView> {
  const existing = await prisma.awsCredential.findUnique({ where: { id } });
  if (!existing) throw new Error('AWS credential not found');

  const accessKeyId = input.accessKeyId?.trim() || existing.accessKeyId;
  let secretPlain = existing.secretAccessKey;
  if (
    input.secretAccessKey !== undefined &&
    input.secretAccessKey !== SECRET_PLACEHOLDER &&
    input.secretAccessKey.trim()
  ) {
    secretPlain = encryptSecret(input.secretAccessKey.trim());
  }

  const defaultRegion = normalizeRegion(input.defaultRegion ?? existing.defaultRegion);
  const iamRoleName =
    input.iamRoleName !== undefined
      ? input.iamRoleName?.trim() || null
      : existing.iamRoleName;

  let iamUsername = existing.iamUsername;
  let awsAccountId = existing.awsAccountId;
  const credsChanged =
    input.accessKeyId ||
    (input.secretAccessKey &&
      input.secretAccessKey !== SECRET_PLACEHOLDER &&
      input.secretAccessKey.trim()) ||
    input.defaultRegion !== undefined ||
    input.iamRoleName !== undefined;

  if (credsChanged) {
    const base = await resolveAwsCredentials(id);
    if (base) {
      if (input.secretAccessKey && input.secretAccessKey !== SECRET_PLACEHOLDER) {
        base.secretAccessKey = input.secretAccessKey.trim();
      }
      if (input.accessKeyId) base.accessKeyId = accessKeyId;
      if (input.defaultRegion) base.defaultRegion = defaultRegion;

      const effective = await assumeRoleIfConfigured(base, {
        iamRoleName,
        awsAccountId: existing.awsAccountId,
        sessionLabel: `SecureNexus-${input.name ?? existing.name}`,
      });
      iamUsername = await resolveIamUsername(effective);
      awsAccountId = await callerAccountId(effective);
    }
  }

  const row = await prisma.awsCredential.update({
    where: { id },
    data: {
      name: input.name?.trim() || existing.name,
      accessKeyId,
      secretAccessKey: secretPlain,
      defaultRegion,
      iamUsername,
      awsAccountId,
      iamRoleName,
      updatedBy,
    },
  });

  return toView(row);
}

export async function deleteAwsCredential(id: string): Promise<void> {
  await prisma.awsCredential.delete({ where: { id } });
}

export async function testAwsCredentialConnection(
  credentials: AwsCredentials,
  opts?: { iamRoleName?: string | null; sessionLabel?: string; awsAccountId?: string | null }
): Promise<AwsConnectionTestResult> {
  let effective = credentials;
  try {
    effective = await assumeRoleIfConfigured(credentials, {
      iamRoleName: opts?.iamRoleName,
      awsAccountId: opts?.awsAccountId ?? null,
      sessionLabel: opts?.sessionLabel ?? 'SecureNexus-test',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Role assumption failed';
    return { ok: false, message };
  }

  const { sts, eks } = clientsFor(effective);
  const roleNote = opts?.iamRoleName?.trim() ? ' (via assumed role)' : '';

  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const account = identity.Account ?? undefined;
    const arn = identity.Arn ?? undefined;
    const userId = identity.UserId ?? undefined;
    const iamUsername = iamUsernameFromArn(arn);

    let clustersListed = 0;
    try {
      const list = await eks.send(new ListClustersCommand({ maxResults: 100 }));
      clustersListed = list.clusters?.length ?? 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'EKS list failed';
      return {
        ok: false,
        message: `Credentials valid (account ${account})${roleNote} but EKS access failed: ${message}`,
        account,
        arn,
        userId,
        iamUsername: iamUsername ?? undefined,
      };
    }

    return {
      ok: true,
      message: `Connection successful${roleNote} · account ${account} · ${clustersListed} EKS cluster${clustersListed === 1 ? '' : 's'} visible`,
      account,
      arn,
      userId,
      iamUsername: iamUsername ?? undefined,
      clustersListed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AWS connection failed';
    return { ok: false, message };
  }
}

function instanceName(instance: Instance): string {
  const nameTag = instance.Tags?.find((t) => t.Key === 'Name')?.Value;
  return nameTag?.trim() || instance.InstanceId || 'unknown';
}

/** EKS managed nodes carry these tags — exclude from manual non-EKS schedules. */
function isEksManagedInstance(instance: Instance): boolean {
  return Boolean(
    instance.Tags?.some((tag) => {
      const key = tag.Key ?? '';
      if (key === 'eks:cluster-name' || key === 'eks:eks-cluster-name' || key === 'eks:nodegroup-name') {
        return true;
      }
      return key.startsWith('kubernetes.io/cluster/') && tag.Value === 'owned';
    })
  );
}

const EC2_INSTANCE_CACHE_TTL_MS = 10 * 60 * 1000;
const ec2InstanceCache = new Map<string, { at: number; instances: Ec2InstanceSummary[] }>();

export function invalidateEc2InstanceCache(credentialId?: string) {
  if (credentialId) {
    for (const key of Array.from(ec2InstanceCache.keys())) {
      if (key.startsWith(`${credentialId}::`)) ec2InstanceCache.delete(key);
    }
    return;
  }
  ec2InstanceCache.clear();
}

async function resolveEc2Regions(
  credentialId: string,
  credentials: { defaultRegion: string },
  defaultClient: ReturnType<ReturnType<typeof clientsFor>['ec2']>,
  allRegions: boolean
): Promise<string[]> {
  if (allRegions) {
    try {
      const regionsResp = await defaultClient.send(new DescribeRegionsCommand({ AllRegions: false }));
      return (
        regionsResp.Regions?.map((r) => r.RegionName).filter((r): r is string => Boolean(r)) ?? [
          credentials.defaultRegion,
        ]
      );
    } catch {
      return credentials.defaultRegion?.trim() ? [credentials.defaultRegion] : ['us-east-1'];
    }
  }

  const preferred = credentials.defaultRegion?.trim();
  const scheduleRegions = await prisma.schedule
    .findMany({
      where: { awsCredentialId: credentialId, ec2Region: { not: null } },
      distinct: ['ec2Region'],
      select: { ec2Region: true },
    })
    .then((rows) => rows.map((r) => r.ec2Region).filter(Boolean) as string[]);

  const regions = Array.from(new Set([...(preferred ? [preferred] : []), ...scheduleRegions]));
  return regions.length ? regions : preferred ? [preferred] : ['us-east-1'];
}

export async function listEc2InstancesForCredential(
  credentialId: string,
  options?: { allRegions?: boolean }
): Promise<Ec2InstanceSummary[]> {
  const cacheKey = `${credentialId}::${options?.allRegions ? 'all' : 'default'}`;
  const cached = ec2InstanceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EC2_INSTANCE_CACHE_TTL_MS) {
    return cached.instances;
  }

  const { credentials } = await resolveEffectiveCredentials(credentialId);

  const { ec2 } = clientsFor(credentials);
  const defaultClient = ec2(credentials.defaultRegion);

  const regions = await resolveEc2Regions(
    credentialId,
    credentials,
    defaultClient,
    Boolean(options?.allRegions)
  );

  const instances: Ec2InstanceSummary[] = [];

  await Promise.all(
    regions.map(async (region) => {
      try {
        const client = ec2(region);
        let nextToken: string | undefined;
        do {
          const resp = await client.send(
            new DescribeInstancesCommand({
              NextToken: nextToken,
              Filters: [
                {
                  Name: 'instance-state-name',
                  Values: ['pending', 'running', 'stopping', 'stopped'],
                },
              ],
            })
          );
          for (const reservation of resp.Reservations ?? []) {
            for (const instance of reservation.Instances ?? []) {
              if (!instance.InstanceId || isEksManagedInstance(instance)) continue;
              instances.push({
                instanceId: instance.InstanceId,
                name: instanceName(instance),
                region,
                state: instance.State?.Name ?? 'unknown',
                instanceType: instance.InstanceType ?? 'unknown',
              });
            }
          }
          nextToken = resp.NextToken;
        } while (nextToken);
      } catch {
        // skip regions without access
      }
    })
  );

  const sorted = instances.sort(
    (a, b) => a.name.localeCompare(b.name) || a.region.localeCompare(b.region)
  );
  ec2InstanceCache.set(cacheKey, { at: Date.now(), instances: sorted });
  return sorted;
}

/** Look up instance types for specific EC2 instances (one region + credential per batch). */
export async function lookupEc2InstanceTypes(
  queries: Array<{ credentialId: string; instanceId: string; region: string }>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!queries.length) return result;

  const batches = new Map<
    string,
    { credentialId: string; region: string; instanceIds: Set<string> }
  >();

  for (const q of queries) {
    if (!q.credentialId || !q.instanceId || !q.region) continue;
    const key = `${q.credentialId}::${normalizeRegion(q.region)}`;
    const batch = batches.get(key) ?? {
      credentialId: q.credentialId,
      region: normalizeRegion(q.region),
      instanceIds: new Set<string>(),
    };
    batch.instanceIds.add(q.instanceId);
    batches.set(key, batch);
  }

  await Promise.all(
    Array.from(batches.values()).map(async ({ credentialId, region, instanceIds }) => {
      try {
        const { credentials } = await resolveEffectiveCredentials(credentialId);
        const client = clientsFor(credentials).ec2(region);
        const resp = await client.send(
          new DescribeInstancesCommand({ InstanceIds: Array.from(instanceIds) })
        );
        for (const reservation of resp.Reservations ?? []) {
          for (const instance of reservation.Instances ?? []) {
            if (instance.InstanceId && instance.InstanceType) {
              result.set(instance.InstanceId, instance.InstanceType);
            }
          }
        }
      } catch {
        // Instance type stays unknown when AWS lookup fails.
      }
    })
  );

  return result;
}

/** Look up Name tag and instance type for specific EC2 instances. */
export async function lookupEc2InstanceDetails(
  queries: Array<{ credentialId: string; instanceId: string; region: string }>
): Promise<Map<string, { name: string; instanceType: string }>> {
  const result = new Map<string, { name: string; instanceType: string }>();
  if (!queries.length) return result;

  const batches = new Map<
    string,
    { credentialId: string; region: string; instanceIds: Set<string> }
  >();

  for (const q of queries) {
    if (!q.credentialId || !q.instanceId || !q.region) continue;
    const key = `${q.credentialId}::${normalizeRegion(q.region)}`;
    const batch = batches.get(key) ?? {
      credentialId: q.credentialId,
      region: normalizeRegion(q.region),
      instanceIds: new Set<string>(),
    };
    batch.instanceIds.add(q.instanceId);
    batches.set(key, batch);
  }

  await Promise.all(
    Array.from(batches.values()).map(async ({ credentialId, region, instanceIds }) => {
      try {
        const { credentials } = await resolveEffectiveCredentials(credentialId);
        const client = clientsFor(credentials).ec2(region);
        const resp = await client.send(
          new DescribeInstancesCommand({ InstanceIds: Array.from(instanceIds) })
        );
        for (const reservation of resp.Reservations ?? []) {
          for (const instance of reservation.Instances ?? []) {
            if (!instance.InstanceId) continue;
            result.set(instance.InstanceId, {
              name: instanceName(instance),
              instanceType: instance.InstanceType ?? 'unknown',
            });
          }
        }
      } catch {
        // Name/type stay unknown when AWS lookup fails.
      }
    })
  );

  return result;
}

export async function stopEc2Instance(
  credentialId: string,
  instanceId: string,
  region: string
): Promise<void> {
  const { credentials } = await resolveEffectiveCredentials(credentialId);
  const client = clientsFor(credentials).ec2(region);
  await client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
}

export async function startEc2Instance(
  credentialId: string,
  instanceId: string,
  region: string
): Promise<void> {
  const { credentials } = await resolveEffectiveCredentials(credentialId);
  const client = clientsFor(credentials).ec2(region);
  await client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
}

export async function generateIamPolicyForCredential(credentialId?: string): Promise<{
  policy: IamPolicyDocument;
  policyJson: string;
  clusterArns: string[];
  notes: string[];
}> {
  const row = credentialId
    ? await prisma.awsCredential.findUnique({ where: { id: credentialId } })
    : null;
  const credentials = row
    ? await resolveEffectiveCredentials(credentialId!)
        .then((r) => r.credentials)
        .catch(async () => resolveAwsCredentials(credentialId))
    : await resolveAwsCredentials(credentialId);

  let accountId = row?.awsAccountId ?? 'YOUR_AWS_ACCOUNT_ID';
  if (credentials) {
    const resolved = await callerAccountId(credentials);
    if (resolved) accountId = resolved;
  }

  const awsClusters = await prisma.cluster.findMany({
    where: { provider: 'aws', awsClusterName: { not: null }, region: { not: null } },
    select: { awsClusterName: true, region: true },
  });

  const clusterArns =
    awsClusters.length > 0
      ? awsClusters.map(
          (c) => `arn:aws:eks:${c.region}:${accountId}:cluster/${c.awsClusterName}`
        )
      : [`arn:aws:eks:*:${accountId}:cluster/*`];

  const statements: IamPolicyDocument['Statement'] = [      {
        Sid: 'SecureNexusVerifyIdentity',
        Effect: 'Allow',
        Action: ['sts:GetCallerIdentity'],
        Resource: '*',
      },
      {
        Sid: 'SecureNexusEKSClusterAccess',
        Effect: 'Allow',
        Action: ['eks:DescribeCluster'],
        Resource: clusterArns,
      },
      {
        Sid: 'SecureNexusEKSListClusters',
        Effect: 'Allow',
        Action: ['eks:ListClusters'],
        Resource: '*',
      },
      {
        Sid: 'SecureNexusEC2Schedule',
        Effect: 'Allow',
        Action: [
          'ec2:DescribeRegions',
          'ec2:DescribeInstances',
          'ec2:StartInstances',
          'ec2:StopInstances',
        ],
        Resource: '*',
      },
    ];

  if (row?.iamRoleName?.trim()) {
    const roleArn = buildRoleArn(row.iamRoleName, accountId);
    statements.push({
      Sid: 'SecureNexusAssumeRole',
      Effect: 'Allow',
      Action: ['sts:AssumeRole'],
      Resource: roleArn,
    });
  }

  const policy: IamPolicyDocument = {
    Version: '2012-10-17',
    Statement: statements,
  };

  const notes = [
    'Attach this policy to the IAM user used for SecureNexus programmatic access.',
    'Kubernetes API permissions (scale deployments, read pods) are granted via EKS access entries or the aws-auth ConfigMap — not IAM actions alone.',
    'EC2 permissions allow Non-EKS schedule stop/start and instance discovery across regions.',
    row?.iamRoleName?.trim()
      ? `This account assumes role "${row.iamRoleName}" for API calls. Grant sts:AssumeRole on that role to the IAM user above, and attach EC2/EKS permissions to the role itself.`
      : null,
    awsClusters.length
      ? `Cluster ARNs are scoped to ${awsClusters.length} EKS cluster(s) registered in SecureNexus.`
      : 'No AWS EKS clusters registered yet — using a wildcard cluster ARN pattern. Re-generate after adding clusters for tighter scope.',
  ].filter((note): note is string => Boolean(note));

  if (accountId === 'YOUR_AWS_ACCOUNT_ID') {
    notes.push('Save and test AWS credentials first to auto-fill your account ID in cluster ARNs.');
  }

  return {
    policy,
    policyJson: JSON.stringify(policy, null, 2),
    clusterArns,
    notes,
  };
}
