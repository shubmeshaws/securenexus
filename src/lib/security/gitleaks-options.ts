export type GitleaksScanMode =
  | 'detect'
  | 'detect-verbose'
  | 'protect'
  | 'protect-staged'
  | 'detect-no-git';

export interface GitleaksScanOptions {
  mode: GitleaksScanMode;
}

export const GITLEAKS_SCAN_MODES: {
  id: GitleaksScanMode;
  label: string;
  description: string;
  command: string;
}[] = [
  {
    id: 'detect',
    label: 'Detect — full repository',
    description:
      'Scan the entire git repository including history for secrets that were committed in the past.',
    command: 'gitleaks detect',
  },
  {
    id: 'detect-verbose',
    label: 'Detect — verbose',
    description: 'Full history scan with detailed finding output for each secret.',
    command: 'gitleaks detect -v',
  },
  {
    id: 'protect',
    label: 'Protect — uncommitted changes',
    description: 'Scan uncommitted code changes to prevent accidental secret commits.',
    command: 'gitleaks protect',
  },
  {
    id: 'protect-staged',
    label: 'Protect — staged only',
    description: 'Scan only files in the git staging area before commit.',
    command: 'gitleaks protect --staged',
  },
  {
    id: 'detect-no-git',
    label: 'Detect — no git',
    description: 'Filesystem scan without git history for non-version-controlled sources.',
    command: 'gitleaks detect --no-git',
  },
];

export const DEFAULT_GITLEAKS_SCAN_OPTIONS: GitleaksScanOptions = { mode: 'detect' };

export function parseGitleaksScanOptions(value: unknown): GitleaksScanOptions {
  if (!value || typeof value !== 'object') return DEFAULT_GITLEAKS_SCAN_OPTIONS;
  const mode = (value as { mode?: string }).mode;
  if (GITLEAKS_SCAN_MODES.some((row) => row.id === mode)) {
    return { mode: mode as GitleaksScanMode };
  }
  return DEFAULT_GITLEAKS_SCAN_OPTIONS;
}

export function gitleaksModeLabel(mode: GitleaksScanMode): string {
  return GITLEAKS_SCAN_MODES.find((row) => row.id === mode)?.label ?? 'Detect';
}

export function buildGitleaksCliArgs(
  options: GitleaksScanOptions,
  repoPath: string,
  reportPath: string
): string[] {
  const shared = [
    '--source',
    repoPath,
    '--report-format',
    'json',
    '--report-path',
    reportPath,
    '--no-banner',
    '--redact',
  ];

  switch (options.mode) {
    case 'detect-verbose':
      return ['detect', '-v', ...shared];
    case 'protect':
      return ['protect', ...shared];
    case 'protect-staged':
      return ['protect', '--staged', ...shared];
    case 'detect-no-git':
      return ['detect', '--no-git', ...shared];
    case 'detect':
    default:
      return ['detect', ...shared];
  }
}
