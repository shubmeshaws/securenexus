import prisma from './prisma';

type ScanJobDelegate = {
  create: (...args: unknown[]) => unknown;
  findUnique: (...args: unknown[]) => unknown;
  findFirst: (...args: unknown[]) => unknown;
  findMany: (...args: unknown[]) => unknown;
  update: (...args: unknown[]) => unknown;
  delete: (...args: unknown[]) => unknown;
};

export function getSecurityScanJobDelegate(): ScanJobDelegate {
  const delegate = (prisma as unknown as { securityScanJob?: ScanJobDelegate }).securityScanJob;
  if (!delegate) {
    throw new Error(
      'Security scan jobs are unavailable. Run `npm run db:push` and restart the SecureNexus server.'
    );
  }
  return delegate;
}
