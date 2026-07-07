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
