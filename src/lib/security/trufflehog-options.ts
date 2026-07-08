export type TrufflehogScanMode = 'git' | 'filesystem';

export interface TrufflehogScanOptions {
  mode: TrufflehogScanMode;
}

export const DEFAULT_TRUFFLEHOG_SCAN_OPTIONS: TrufflehogScanOptions = {
  mode: 'git',
};

export const TRUFFLEHOG_SCAN_MODES: {
  id: TrufflehogScanMode;
  label: string;
  description: string;
  command: string;
}[] = [
  {
    id: 'git',
    label: 'Git — full history',
    description:
      'Scan the cloned repository including git history for leaked credentials (recommended).',
    command: 'trufflehog git file://<repo>',
  },
  {
    id: 'filesystem',
    label: 'Filesystem — current files',
    description: 'Scan files on disk without git history (faster, no historical secrets).',
    command: 'trufflehog filesystem <repo>',
  },
];

export function trufflehogModeLabel(mode: TrufflehogScanMode): string {
  return TRUFFLEHOG_SCAN_MODES.find((row) => row.id === mode)?.label ?? mode;
}

export function parseTrufflehogScanOptions(value: unknown): TrufflehogScanOptions {
  if (!value || typeof value !== 'object') return { ...DEFAULT_TRUFFLEHOG_SCAN_OPTIONS };
  const mode = (value as { mode?: unknown }).mode;
  if (mode === 'filesystem' || mode === 'git') {
    return { mode };
  }
  return { ...DEFAULT_TRUFFLEHOG_SCAN_OPTIONS };
}

export function buildTrufflehogCliArgs(
  options: TrufflehogScanOptions,
  repoPath: string
): string[] {
  const base = ['--json', '--no-update', '--no-color', '--results=verified,unverified,unknown'];
  if (options.mode === 'filesystem') {
    return ['filesystem', repoPath, ...base];
  }
  const uri = repoPath.startsWith('file://') ? repoPath : `file://${repoPath}`;
  return ['git', uri, ...base];
}
