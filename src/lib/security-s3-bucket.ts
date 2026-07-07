import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import { resolveEffectiveCredentials } from '@/lib/aws-credential-store';
import { assertSecurityModuleEnabled } from '@/lib/security-service';
import type { AwsCredentials } from '@/lib/aws-settings';

export type S3BucketEnsureStatus = 'created' | 'already_exists';

export interface S3BucketEnsureResult {
  status: S3BucketEnsureStatus;
  bucket: string;
  region: string;
  message: string;
}

function normalizeBucketName(name: string): string {
  return name.trim().toLowerCase();
}

function validateBucketName(bucket: string): string | null {
  if (!bucket) return 'Bucket name is required.';
  if (bucket.length < 3 || bucket.length > 63) {
    return 'Bucket name must be between 3 and 63 characters.';
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
    return 'Bucket name cannot be formatted as an IP address.';
  }
  if (bucket.includes('..')) return 'Bucket name cannot contain consecutive periods.';
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)) {
    return 'Bucket name must use only lowercase letters, numbers, hyphens, and periods.';
  }
  return null;
}

function s3Client(credentials: AwsCredentials, region: string): S3Client {
  return new S3Client({
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });
}

function isNotFoundError(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const code = e.name ?? e.Code ?? '';
  if (code === 'NotFound' || code === 'NoSuchBucket') return true;
  return e.$metadata?.httpStatusCode === 404;
}

function isAlreadyExistsError(err: unknown): boolean {
  const e = err as { name?: string; Code?: string };
  const code = e.name ?? e.Code ?? '';
  return code === 'BucketAlreadyExists' || code === 'BucketAlreadyOwnedByYou';
}

export async function ensureSecurityS3Bucket(input: {
  awsCredentialId: string;
  bucket: string;
  region?: string;
}): Promise<S3BucketEnsureResult> {
  await assertSecurityModuleEnabled();

  const bucket = normalizeBucketName(input.bucket);
  const nameError = validateBucketName(bucket);
  if (nameError) throw new Error(nameError);
  if (!input.awsCredentialId.trim()) {
    throw new Error('Select an AWS credential from Admin → Settings.');
  }

  const { credentials } = await resolveEffectiveCredentials(input.awsCredentialId.trim());
  const region = (input.region?.trim() || credentials.defaultRegion || 'ap-south-1').trim();
  const client = s3Client(credentials, region);

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return {
      status: 'already_exists',
      bucket,
      region,
      message: 'Bucket already exists.',
    };
  } catch (err) {
    if (!isNotFoundError(err)) {
      const e = err as { name?: string };
      if (e.name === 'Forbidden') {
        throw new Error(
          'Bucket name is unavailable or you do not have permission to access it.'
        );
      }
      throw err instanceof Error ? err : new Error('Failed to check bucket status.');
    }
  }

  try {
    await client.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(region !== 'us-east-1'
          ? {
              CreateBucketConfiguration: {
                LocationConstraint: region as BucketLocationConstraint,
              },
            }
          : {}),
      })
    );
    return {
      status: 'created',
      bucket,
      region,
      message: 'Bucket created successfully.',
    };
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      return {
        status: 'already_exists',
        bucket,
        region,
        message: 'Bucket already exists.',
      };
    }
    const message = err instanceof Error ? err.message : 'Failed to create S3 bucket.';
    throw new Error(message);
  }
}
