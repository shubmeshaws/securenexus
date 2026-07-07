import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import prisma from '@/lib/prisma';
import { resolveEffectiveCredentials } from '@/lib/aws-credential-store';
import {
  getSecurityReportCsv,
  getSecurityReportHtml,
  getSecurityReportPdfBuffer,
} from '@/lib/security-service';

function sanitizeFilename(title: string): string {
  return title.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'report';
}

function normalizePrefix(prefix: string | null | undefined): string {
  const trimmed = (prefix ?? 'security-reports/').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `${trimmed}/` : '';
}

export async function uploadAutomationReportsToS3(input: {
  automationName: string;
  s3Bucket: string;
  s3Region?: string | null;
  s3Prefix?: string | null;
  awsCredentialId: string;
  scanJobId: string;
  completedAt?: Date;
}): Promise<{ uploaded: number; keys: string[] }> {
  const reports = await prisma.securityReport.findMany({
    where: { scanJobId: input.scanJobId },
    orderBy: { createdAt: 'asc' },
  });
  if (!reports.length) {
    throw new Error('No reports found to upload to S3');
  }

  const { credentials } = await resolveEffectiveCredentials(input.awsCredentialId);
  const region = input.s3Region?.trim() || credentials.defaultRegion;
  const client = new S3Client({
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });

  const folder = `${normalizePrefix(input.s3Prefix)}${sanitizeFilename(input.automationName)}/${
    (input.completedAt ?? new Date()).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  }`;

  const keys: string[] = [];

  for (const report of reports) {
    const baseName = sanitizeFilename(report.title);
    const [{ html }, { csv }, { buffer }] = await Promise.all([
      getSecurityReportHtml(report.id),
      getSecurityReportCsv(report.id),
      getSecurityReportPdfBuffer(report.id),
    ]);

    const uploads: Array<{ key: string; body: string | Buffer; contentType: string }> = [
      { key: `${folder}/${baseName}.html`, body: html, contentType: 'text/html; charset=utf-8' },
      { key: `${folder}/${baseName}.csv`, body: csv, contentType: 'text/csv; charset=utf-8' },
      { key: `${folder}/${baseName}.pdf`, body: buffer, contentType: 'application/pdf' },
    ];

    for (const upload of uploads) {
      await client.send(
        new PutObjectCommand({
          Bucket: input.s3Bucket,
          Key: upload.key,
          Body: upload.body,
          ContentType: upload.contentType,
        })
      );
      keys.push(upload.key);
    }
  }

  return { uploaded: keys.length, keys };
}

export function buildS3ObjectUrl(
  bucket: string,
  region: string | null | undefined,
  key: string
): string {
  const encodedKey = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const resolvedRegion = region?.trim() || 'us-east-1';
  if (resolvedRegion === 'us-east-1') {
    return `https://${bucket}.s3.amazonaws.com/${encodedKey}`;
  }
  return `https://${bucket}.s3.${resolvedRegion}.amazonaws.com/${encodedKey}`;
}

export function buildS3ConsoleBucketUrl(
  bucket: string,
  region: string | null | undefined
): string {
  const resolvedRegion = region?.trim() || 'us-east-1';
  return `https://s3.console.aws.amazon.com/s3/buckets/${encodeURIComponent(bucket)}?region=${encodeURIComponent(resolvedRegion)}`;
}

export function buildS3ConsoleFolderUrl(
  bucket: string,
  region: string | null | undefined,
  prefix: string
): string {
  const resolvedRegion = region?.trim() || 'us-east-1';
  const encodedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `https://s3.console.aws.amazon.com/s3/buckets/${encodeURIComponent(bucket)}?region=${encodeURIComponent(resolvedRegion)}&prefix=${encodeURIComponent(encodedPrefix)}`;
}

export function groupS3ReportLinks(input: {
  bucket: string;
  region: string | null | undefined;
  keys: string[];
}): Array<{ title: string; htmlUrl: string; csvUrl: string; pdfUrl: string }> {
  const byBase = new Map<string, { html?: string; csv?: string; pdf?: string }>();

  for (const key of input.keys) {
    const match = key.match(/\/([^/]+)\.(html|csv|pdf)$/i);
    if (!match) continue;
    const baseName = match[1];
    const ext = match[2].toLowerCase() as 'html' | 'csv' | 'pdf';
    const row = byBase.get(baseName) ?? {};
    row[ext] = buildS3ObjectUrl(input.bucket, input.region, key);
    byBase.set(baseName, row);
  }

  return Array.from(byBase.entries())
    .filter(([, urls]) => urls.html)
    .map(([baseName, urls]) => ({
      title: baseName.replace(/-/g, ' '),
      htmlUrl: urls.html!,
      csvUrl: urls.csv ?? urls.html!,
      pdfUrl: urls.pdf ?? urls.html!,
    }));
}
