import { EKSClient, DescribeClusterCommand, ListClustersCommand } from '@aws-sdk/client-eks';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import prisma from './prisma';
import { encryptSecret, decryptSecret } from './crypto';
import { getSetting, SETTING_KEYS, SECRET_PLACEHOLDER } from './settings';

export { SECRET_PLACEHOLDER };

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  defaultRegion: string;
  sessionToken?: string;
}

export interface AwsSettingsView {
  accessKeyId: string;
  secretAccessKeySet: boolean;
  defaultRegion: string;
  iamUsername: string | null;
}

export interface AwsConnectionTestResult {
  ok: boolean;
  message: string;
  account?: string;
  arn?: string;
  userId?: string;
  iamUsername?: string;
  clustersListed?: number;
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

async function upsertSetting(key: string, value: string, isSecret = false) {
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value, isSecret },
    update: { value, isSecret },
  });
}

async function resolveAndStoreIamUsername(credentials: AwsCredentials): Promise<string | null> {
  try {
    const { sts } = clientsFor(credentials);
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const username = iamUsernameFromArn(identity.Arn ?? null);
    if (username) {
      await upsertSetting(SETTING_KEYS.AWS_IAM_USERNAME, username);
      const { invalidateSettingsCache } = await import('./settings');
      invalidateSettingsCache();
    }
    return username;
  } catch {
    return null;
  }
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
    },
  };
  return {
    sts: new STSClient(config),
    eks: new EKSClient(config),
    region,
  };
}

export async function getAwsCredentials(credentialId?: string | null): Promise<AwsCredentials | null> {
  const { resolveAwsCredentials, resolveEffectiveCredentials, listAwsCredentials } =
    await import('./aws-credential-store');

  if (credentialId) {
    try {
      return (await resolveEffectiveCredentials(credentialId)).credentials;
    } catch {
      return resolveAwsCredentials(credentialId);
    }
  }

  const creds = await listAwsCredentials();
  const first = creds[0];
  if (!first) return resolveAwsCredentials();

  try {
    return (await resolveEffectiveCredentials(first.id)).credentials;
  } catch {
    return resolveAwsCredentials(first.id);
  }
}

export async function getAwsSettingsView(): Promise<AwsSettingsView> {
  const { listAwsCredentials } = await import('./aws-credential-store');
  const creds = await listAwsCredentials();
  const first = creds[0];
  if (!first?.secretAccessKeySet) {
    return {
      accessKeyId: '',
      secretAccessKeySet: false,
      defaultRegion: 'ap-south-1',
      iamUsername: null,
    };
  }
  return {
    accessKeyId: first.accessKeyId,
    secretAccessKeySet: true,
    defaultRegion: first.defaultRegion,
    iamUsername: first.iamUsername,
  };
}

const AWS_SETTING_KEYS = [
  SETTING_KEYS.AWS_ACCESS_KEY_ID,
  SETTING_KEYS.AWS_SECRET_ACCESS_KEY,
  SETTING_KEYS.AWS_DEFAULT_REGION,
  SETTING_KEYS.AWS_LAST_TEST_AT,
  SETTING_KEYS.AWS_LAST_TEST_OK,
  SETTING_KEYS.AWS_LAST_TEST_MESSAGE,
  SETTING_KEYS.AWS_IAM_USERNAME,
] as const;

async function clearStaleAwsMetadata(): Promise<void> {
  await prisma.systemSetting.deleteMany({
    where: {
      key: {
        in: [
          SETTING_KEYS.AWS_ACCESS_KEY_ID,
          SETTING_KEYS.AWS_IAM_USERNAME,
          SETTING_KEYS.AWS_LAST_TEST_AT,
          SETTING_KEYS.AWS_LAST_TEST_OK,
          SETTING_KEYS.AWS_LAST_TEST_MESSAGE,
        ],
      },
    },
  });
  const { invalidateSettingsCache } = await import('./settings');
  invalidateSettingsCache();
}

export async function clearAwsCredentials(): Promise<AwsSettingsView> {
  const { listAwsCredentials, deleteAwsCredential } = await import('./aws-credential-store');
  const creds = await listAwsCredentials();
  await Promise.all(creds.map((c) => deleteAwsCredential(c.id)));
  return getAwsSettingsView();
}

export async function saveAwsCredentials(
  input: {
    name?: string;
    accessKeyId: string;
    secretAccessKey?: string;
    defaultRegion: string;
  },
  updatedBy?: string
): Promise<AwsSettingsView> {
  const { listAwsCredentials, createAwsCredential, updateAwsCredential } = await import(
    './aws-credential-store'
  );
  const existing = await listAwsCredentials();
  const first = existing[0];

  if (first) {
    await updateAwsCredential(
      first.id,
      {
        name: input.name ?? first.name,
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        defaultRegion: input.defaultRegion,
      },
      updatedBy
    );
  } else {
    if (!input.secretAccessKey?.trim() || input.secretAccessKey === SECRET_PLACEHOLDER) {
      throw new Error('AWS secret access key is required');
    }
    await createAwsCredential(
      {
        name: input.name?.trim() || 'Default',
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
        defaultRegion: input.defaultRegion,
      },
      updatedBy
    );
  }

  return getAwsSettingsView();
}

export async function testAwsCredentials(
  credentials: AwsCredentials
): Promise<AwsConnectionTestResult> {
  const { sts, eks } = clientsFor(credentials);

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
        message: `Credentials valid (account ${account}) but EKS access failed: ${message}`,
        account,
        arn,
        userId,
        iamUsername: iamUsername ?? undefined,
      };
    }

    return {
      ok: true,
      message: `Connection successful · ${clustersListed} EKS cluster${clustersListed === 1 ? '' : 's'} visible`,
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

export async function resolveAwsCredentialsForTest(input: {
  id?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  defaultRegion?: string;
}): Promise<AwsCredentials | null> {
  const { listAwsCredentials, resolveAwsCredentialsForInput } = await import(
    './aws-credential-store'
  );
  const creds = await listAwsCredentials();
  const id = input.id ?? creds[0]?.id;
  if (!id) {
    const accessKeyId = input.accessKeyId?.trim() ?? '';
    const secretAccessKey = input.secretAccessKey?.trim() ?? '';
    const defaultRegion = normalizeRegion(input.defaultRegion ?? 'ap-south-1');
    if (!accessKeyId || !secretAccessKey || secretAccessKey === SECRET_PLACEHOLDER) return null;
    return { accessKeyId, secretAccessKey, defaultRegion };
  }
  return resolveAwsCredentialsForInput(id, input);
}

export interface IamPolicyDocument {
  Version: '2012-10-17';
  Statement: Array<{
    Sid: string;
    Effect: 'Allow' | 'Deny';
    Action: string | string[];
    Resource: string | string[];
  }>;
}

/** Minimal IAM policy for SecureNexus EKS + EC2 integration (programmatic access). */
export async function generateSecureNexusIamPolicy(credentialId?: string): Promise<{
  policy: IamPolicyDocument;
  policyJson: string;
  clusterArns: string[];
  notes: string[];
}> {
  const { generateIamPolicyForCredential } = await import('./aws-credential-store');
  return generateIamPolicyForCredential(credentialId);
}
