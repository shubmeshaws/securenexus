import { scrubGitSyncByCommitFiles } from '../src/lib/git-resource-audit-join';
import { changedFilesForCommit } from '../src/lib/git-resource-diff';
import path from 'path';
import prisma from '../src/lib/prisma';

async function main() {
  const clonePath = path.join(__dirname, '..', '.git-repos/prismforce__helm-charts');
  const sha = 'dff9f1617c7e202506b789ae8e1d83fc132be4dd';
  const files = await changedFilesForCommit(clonePath, sha);
  console.log('files', files);
  const removed = await scrubGitSyncByCommitFiles({ commitSha: sha, changedFiles: files });
  console.log('removed', removed);
  const left = await prisma.resourceChangeAudit.findMany({
    where: { revisionSha: { startsWith: 'dff9f16' } },
    select: { argocdApp: true, cluster: true, resourceType: true },
  });
  console.log('remaining', JSON.stringify(left, null, 2));
}

main().finally(() => prisma.$disconnect());
