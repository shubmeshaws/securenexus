export interface SecretsRemediation {
  summary: string;
  steps: string[];
  commands: string[];
}

function fileFromLocation(location: string): string {
  const colon = location.lastIndexOf(':');
  if (colon <= 0) return location;
  const tail = location.slice(colon + 1);
  if (/^\d+$/.test(tail)) return location.slice(0, colon);
  return location;
}

function gitHistoryCommands(file: string): string[] {
  if (!file || file === 'unknown') {
    return [
      'git filter-repo --invert-paths --path <exposed-file> --force',
      'git push --force-with-lease origin <branch>',
    ];
  }

  return [
    `# Remove from the current branch`,
    `git rm --cached "${file}" && git commit -m "Remove exposed secret from ${file}"`,
    `# Purge from full git history (requires git-filter-repo)`,
    `git filter-repo --path "${file}" --invert-paths --force`,
    `git push --force-with-lease origin <branch>`,
  ];
}

function withGitPurge(
  summary: string,
  steps: string[],
  location: string
): SecretsRemediation {
  return {
    summary,
    steps: [...steps, 'Purge the secret from git history before pushing again'],
    commands: gitHistoryCommands(fileFromLocation(location)),
  };
}

type RemediationMatcher = {
  test: (rule: string) => boolean;
  build: (location: string) => SecretsRemediation;
};

const REMEDIATION_MATCHERS: RemediationMatcher[] = [
  {
    test: (rule) => /aws|akia|asia|amazon/i.test(rule),
    build: (location) =>
      withGitPurge(
        'Rotate AWS credentials and remove them from source control.',
        [
          'Deactivate or delete the exposed access key in AWS IAM → Users → Security credentials',
          'Create a replacement key and store it in AWS Secrets Manager or SSM Parameter Store',
          'Reference credentials via environment variables (e.g. AWS_ACCESS_KEY_ID) or IAM roles — never hardcode',
        ],
        location
      ),
  },
  {
    test: (rule) => /github.*pat|github-pat|github-fine-grained|github_pat/i.test(rule),
    build: (location) =>
      withGitPurge(
        'Revoke the GitHub token and switch to secrets or OIDC.',
        [
          'Revoke the token at GitHub → Settings → Developer settings → Personal access tokens',
          'Create a new token with least privilege, or use GitHub Actions secrets / OIDC for CI',
          'Load via process.env.GITHUB_TOKEN (or GITHUB_PAT) — never commit tokens',
        ],
        location
      ),
  },
  {
    test: (rule) => /github.*oauth|github.*app|ghu_|ghs_|gho_/i.test(rule),
    build: (location) =>
      withGitPurge(
        'Revoke the GitHub OAuth/App credential immediately.',
        [
          'Revoke the OAuth token or rotate the GitHub App private key in GitHub settings',
          'Re-issue credentials with minimal scopes and store in your secret manager',
          'Inject at runtime via environment variables or GitHub Actions secrets',
        ],
        location
      ),
  },
  {
    test: (rule) => /gitlab/i.test(rule),
    build: (location) =>
      withGitPurge(
        'Revoke the GitLab token and use CI/CD variables instead.',
        [
          'Revoke the token at GitLab → User Settings → Access Tokens (or Project/Group CI variables)',
          'Create a scoped replacement and add it as a masked CI/CD variable',
          'Reference via process.env.GITLAB_TOKEN — never commit to the repo',
        ],
        location
      ),
  },
  {
    test: (rule) => /private-key|ssh|rsa|openssh|pgp/i.test(rule),
    build: (location) =>
      withGitPurge(
        'Treat the private key as compromised — rotate immediately.',
        [
          'Remove the key file from the repository and add *.pem, id_rsa, *.key to .gitignore',
          'Generate a new key pair: ssh-keygen -t ed25519 -C "deploy@yourorg"',
          'Update authorized_keys, deployment targets, and any services using the old public key',
        ],
        location
      ),
  },
  {
    test: (rule) => /slack/i.test(rule),
    build: (location) =>
      withGitPurge(
        'Regenerate the Slack token or webhook.',
        [
          'Revoke/regenerate at Slack → Apps → Your App → OAuth & Permissions (or Incoming Webhooks)',
          'Store the new value in SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL environment variable',
          'Audit Slack access logs for unauthorized use of the exposed credential',
        ],
        location
      ),
  },
  {
    test: (rule) => /stripe/i.test(rule),
    build: (location) =>
      withGitPurge(
        'Roll Stripe API keys and restrict by IP if possible.',
        [
          'Roll the secret key in Stripe Dashboard → Developers → API keys',
          'Use restricted keys with minimal permissions where supported',
          'Load via process.env.STRIPE_SECRET_KEY on the server only — never in client code',
        ],
        location
      ),
  },
  {
    test: (rule) => /jwt|bearer/i.test(rule),
    build: (location) =>
      withGitPurge(
        'Invalidate the JWT and stop committing tokens.',
        [
          'Invalidate the token at the issuer (auth service) and rotate signing secrets if needed',
          'Use short-lived tokens obtained at runtime; never store long-lived JWTs in source',
          'Keep signing keys in a secret manager, not in the repository',
        ],
        location
      ),
  },
  {
    test: (rule) => /database|postgres|mysql|mongodb|redis|connection-string|jdbc/i.test(rule),
    build: (location) =>
      withGitPurge(
        'Rotate database credentials and use a connection URL env var.',
        [
          'Change the database user password or rotate the connection string secret',
          'Move DATABASE_URL (or equivalent) to .env / secret manager — ensure .env is gitignored',
          'Audit DB logs for connections using the exposed credentials',
        ],
        location
      ),
  },
  {
    test: (rule) => /password|passwd|credential/i.test(rule),
    build: (location) =>
      withGitPurge(
        'Change the password and remove it from the codebase.',
        [
          'Reset the password/account credential with the service provider immediately',
          'Store in a secret manager or environment variable — use .env.example with placeholders only',
          'Enable MFA on the affected account if available',
        ],
        location
      ),
  },
  {
    test: (rule) => /npm|pypi|nuget|maven|docker|registry/i.test(rule),
    build: (location) =>
      withGitPurge(
        'Revoke the package registry token.',
        [
          'Revoke the token in your registry (npm, PyPI, Docker Hub, etc.) and create a scoped replacement',
          'Use CI/CD secrets for publish pipelines; developers should use local credential helpers',
          'Add .npmrc / .pypirc patterns with env var substitution instead of embedded tokens',
        ],
        location
      ),
  },
  {
    test: (rule) => /webhook|hook-url/i.test(rule),
    build: (location) =>
      withGitPurge(
        'Regenerate the webhook URL and restrict access.',
        [
          'Delete and recreate the webhook in the provider dashboard',
          'Store the URL in an environment variable; validate incoming webhook signatures where supported',
        ],
        location
      ),
  },
  {
    test: (rule) => /api[_-]?key|generic-api|secret-key|access-token|token/i.test(rule),
    build: (location) =>
      withGitPurge(
        'Rotate the API key and externalize configuration.',
        [
          'Revoke the key in the provider dashboard and issue a new one with least privilege',
          'Move the value to environment variables or a secret manager (Vault, AWS SM, Doppler, etc.)',
          'Add a pre-commit Gitleaks hook to block future commits: gitleaks protect --staged',
        ],
        location
      ),
  },
];

const DEFAULT_REMEDIATION = (location: string): SecretsRemediation =>
  withGitPurge(
    'Rotate the exposed secret and remove it from git history.',
    [
      'Revoke or rotate the credential with the service provider immediately',
      'Remove the value from source; use environment variables or a secret manager instead',
      'Add the file pattern to .gitignore if it is a local config (never commit real secrets)',
      'Enable Gitleaks in pre-commit: gitleaks protect --staged',
    ],
    location
  );

export function resolveSecretsRemediation(rule: string, location: string): SecretsRemediation {
  const normalizedRule = rule.trim().toLowerCase();
  const matcher = REMEDIATION_MATCHERS.find((entry) => entry.test(normalizedRule));
  return matcher ? matcher.build(location) : DEFAULT_REMEDIATION(location);
}

export function formatRemediationPlainText(remediation: SecretsRemediation): string {
  const parts = [remediation.summary];
  remediation.steps.forEach((step, index) => {
    parts.push(`${index + 1}. ${step}`);
  });
  if (remediation.commands.length) {
    parts.push(`Commands: ${remediation.commands.join(' | ')}`);
  }
  return parts.join(' ');
}
