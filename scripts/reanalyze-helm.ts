import path from 'path';
import { reanalyzeRecentHelmCommits } from '../src/lib/git-resource-audit-join';

async function main() {
  const root = path.join(__dirname, '..');
  const repoId = 'cmqexh2ee0hf0cg4x8g9awr7s';
  const clonePath = path.join(root, '.git-repos/prismforce__helm-charts');
  const headSha = 'dff9f1617c7e202506b789ae8e1d83fc132be4dd';

  const result = await reanalyzeRecentHelmCommits({
    repoId,
    clonePath,
    branch: 'main',
    headSha,
    limit: 50,
  });

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    const { default: prisma } = await import('../src/lib/prisma');
    await prisma.$disconnect();
  });
