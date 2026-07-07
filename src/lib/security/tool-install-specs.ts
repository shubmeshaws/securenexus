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

export type RuntimeInstallToolId = 'semgrep' | 'npm-audit' | 'gitleaks' | 'zap' | 'snyk';

const INSTALL_COMMANDS: Record<RuntimeInstallToolId, Record<ServerOsType, string[]>> = {
  semgrep: {
    macos: [
      'Install Semgrep via Homebrew, pipx, or a local virtual environment',
      'Enable live SAST scans automatically',
    ],
    ubuntu: [
      'Install python3-venv via apt if needed (automatic, uses sudo)',
      'Create .securenexus/venv-semgrep and install Semgrep CE',
      'Enable live SAST scans — no manual terminal steps required',
    ],
    linux: [
      'Install Python 3 dependencies if needed (automatic, uses sudo)',
      'Create .securenexus/venv-semgrep and install Semgrep CE',
      'Enable live SAST scans — no manual terminal steps required',
    ],
  },
  'npm-audit': {
    macos: ['brew install node'],
    ubuntu: ['sudo apt update', 'sudo apt install -y nodejs npm'],
    linux: ['sudo yum install -y nodejs npm || sudo dnf install -y nodejs npm'],
  },
  gitleaks: {
    macos: ['brew install gitleaks'],
    ubuntu: [
      'SecureNexus downloads the latest Gitleaks release from GitHub automatically',
      'Extracts gitleaks_<version>_linux_x64.tar.gz into .securenexus/bin/',
    ],
    linux: [
      'SecureNexus downloads the latest Gitleaks release from GitHub automatically',
      'Extracts gitleaks_<version>_linux_x64.tar.gz into .securenexus/bin/',
    ],
  },
  zap: {
    macos: [
      'brew install --cask zaproxy',
      'Requires Java — install via brew install openjdk if needed',
    ],
    ubuntu: [
      'sudo apt update',
      'sudo apt install -y default-jdk',
      'cd /opt',
      'sudo wget https://github.com/zaproxy/zaproxy/releases/download/v2.16.1/ZAP_2.16.1_Linux.tar.gz',
      'sudo tar -xvzf ZAP_2.16.1_Linux.tar.gz',
      'sudo mv ZAP_2.16.1 zap',
      'Scans run: cd /opt/zap && ./zap.sh -cmd -quickurl <url> -quickout report.html -quickprogress',
    ],
    linux: [
      'sudo yum install -y java-11-openjdk || sudo dnf install -y java-11-openjdk',
      'SecureNexus downloads ZAP 2.16.1 into .securenexus/zap when /opt is not writable',
    ],
  },
  snyk: {
    macos: [
      'Ensure npm is installed (brew install node)',
      'npm install snyk -g',
      'After install, run: snyk auth',
      'Enable Snyk Code and run: snyk code test',
    ],
    ubuntu: [
      'Ensure npm is installed (sudo apt install -y nodejs npm)',
      'npm install snyk -g',
      'Or: curl --compressed https://downloads.snyk.io/cli/stable/snyk-linux -o snyk',
      'chmod +x ./snyk && sudo mv ./snyk /usr/local/bin/',
      'After install, run: snyk auth',
      'Enable Snyk Code and run: snyk code test',
    ],
    linux: [
      'Ensure npm is installed',
      'npm install snyk -g',
      'Or: curl --compressed https://downloads.snyk.io/cli/stable/snyk-linux -o snyk',
      'chmod +x ./snyk && sudo mv ./snyk /usr/local/bin/',
      'After install, run: snyk auth',
      'Enable Snyk Code and run: snyk code test',
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
