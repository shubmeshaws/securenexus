import { linkGitChangesToResourceAudit } from '../src/lib/git-resource-audit-join';
import prisma from '../src/lib/prisma';

async function main() {
  let total = 0;
  for (let i = 0; i < 50; i++) {
    const n = await linkGitChangesToResourceAudit();
    total += n;
    if (n === 0) break;
    console.log('batch', i + 1, 'linked', n);
  }
  console.log('total linked', total);

  const rows = await prisma.resourceChangeAudit.findMany({
    where: { revisionSha: { startsWith: 'dff9f16' } },
    select: { argocdApp: true, cluster: true, resourceType: true, oldValue: true, newValue: true },
  });
  console.log('dff9f16 audit', JSON.stringify(rows, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
