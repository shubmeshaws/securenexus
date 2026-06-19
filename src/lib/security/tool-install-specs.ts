export const SERVER_OS_TYPES = ['macos', 'ubuntu', 'linux'] as const;
export type ServerOsType = (typeof SERVER_OS_TYPES)[number];

export const SERVER_OS_OPTIONS: { id: ServerOsType; label: string; description: string }[] = [
  {
    id: 'macos',
    label: 'macOS',
    description: 'SecureNexus server runs on Apple macOS',
  },
  {
    id: 'ubuntu',
    label: 'Ubuntu',
    description: 'SecureNexus server runs on Ubuntu Linux',
  },
  {
    id: 'linux',
    label: 'Linux',
    description: 'SecureNexus server runs on other Linux (RHEL, Amazon Linux, etc.)',
  },
];

export type RuntimeInstallToolId = 'semgrep' | 'npm-audit' | 'gitleaks';

const INSTALL_COMMANDS: Record<RuntimeInstallToolId, Record<ServerOsType, string[]>> = {
  semgrep: {
    macos: ['brew install semgrep', 'pip3 install semgrep'],
    ubuntu: [
      'sudo apt update',
      'sudo apt install -y python3-pip',
      'pip3 install --user semgrep',
    ],
    linux: ['sudo yum install -y python3-pip || sudo dnf install -y python3-pip', 'pip3 install --user semgrep'],
  },
  'npm-audit': {
    macos: ['brew install node'],
    ubuntu: ['sudo apt update', 'sudo apt install -y nodejs npm'],
    linux: ['sudo yum install -y nodejs npm || sudo dnf install -y nodejs npm'],
  },
  gitleaks: {
    macos: ['brew install gitleaks'],
    ubuntu: [
      'wget -qO /tmp/gitleaks.tar.gz https://github.com/gitleaks/gitleaks/releases/latest/download/gitleaks_linux_x64.tar.gz',
      'sudo tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks',
    ],
    linux: [
      'wget -qO /tmp/gitleaks.tar.gz https://github.com/gitleaks/gitleaks/releases/latest/download/gitleaks_linux_x64.tar.gz',
      'sudo tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks',
    ],
  },
};

export function isServerOsType(value: string): value is ServerOsType {
  return (SERVER_OS_TYPES as readonly string[]).includes(value);
}

export function getInstallCommandsForOs(toolId: string, os: ServerOsType): string[] {
  const commands = INSTALL_COMMANDS[toolId as RuntimeInstallToolId];
  if (!commands) return [];
  return commands[os] ?? [];
}

export function getInstallCommandsByOs(
  toolId: string
): Record<ServerOsType, string[]> | null {
  const commands = INSTALL_COMMANDS[toolId as RuntimeInstallToolId];
  if (!commands) return null;
  return commands;
}
