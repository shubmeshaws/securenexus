import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
}

let prismaClient = globalForPrisma.prisma ?? createPrismaClient();

// After `prisma db push` / generate, dev hot reload may keep an older PrismaClient
// instance without newly added models (e.g. SecurityScanJob).
if (process.env.NODE_ENV !== 'production' && !('securityScanJob' in prismaClient)) {
  prismaClient = createPrismaClient();
}

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prismaClient;
}

export const prisma = prismaClient;
export default prismaClient;
