import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { isGitleaksAvailable } from './gitleaks-runner';
import { isNpmAuditAvailable } from './npm-audit-runner';
import { isSemgrepAvailable } from './semgrep-runner';
import { toolPathEnv } from './tool-path-env';
import {
  getInstallCommandsByOs,
  getInstallCommandsForOs,
  isServerOsType,
  type ServerOsType,
} from './tool-install-specs';

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const LOCAL_BIN = path.join(process.cwd(), '.securenexus', 'bin');

export const RUNTIME_SECURITY_TOOL_IDS = ['semgrep', 'npm-audit', 'gitleaks'] as const;
export type RuntimeSecurityToolId = (typeof RUNTIME_SECURITY_TOOL_IDS)[number];

export type { ServerOsType } from './tool-install-specs';
export {
  getInstallCommandsByOs,
  getInstallCommandsForOs,
  isServerOsType,
  SERVER_OS_OPTIONS,
  SERVER_OS_TYPES,
} from './tool-install-specs';

export interface ToolRuntimeSpec {
  toolId: RuntimeSecurityToolId;
  name: string;
  summary: string;
}

export interface ToolRuntimeStatus {
  toolId: string;
  runtimeRequired: boolean;
  runtimeAvailable: boolean;
  runtimeReady: boolean;
  installedAt: string | null;
  installedOs: ServerOsType | null;
  version: string | null;
  installCommands: string[];
  installCommandsByOs: Record<ServerOsType, string[]> | null;
}

const RUNTIME_SPECS: Record<RuntimeSecurityToolId, Omit<ToolRuntimeSpec, 'toolId'>> = {
  semgrep: {
    name: 'Semgrep',
    summary: 'Semgrep CLI and Python 3 are required for live SAST scans on this server.',
  },
  'npm-audit': {
    name: 'npm audit',
    summary: 'Node.js and npm are required for live dependency scans on this server.',
  },
  gitleaks: {
    name: 'Gitleaks',
    summary: 'Gitleaks CLI is required for live secrets scanning on this server.',
  },
};

export function isRuntimeSecurityTool(toolId: string): toolId is RuntimeSecurityToolId {
  return (RUNTIME_SECURITY_TOOL_IDS as readonly string[]).includes(toolId);
}

export function getToolRuntimeSpec(toolId: string): ToolRuntimeSpec | null {
  if (!isRuntimeSecurityTool(toolId)) return null;
  const spec = RUNTIME_SPECS[toolId];
  return { toolId, ...spec };
}

async function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return `${stdout}\n${stderr}`.trim();
}

async function runShell(command: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return `${stdout}\n${stderr}`.trim();
}

async function hasCommand(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureLocalBin(): Promise<string> {
  await fs.mkdir(LOCAL_BIN, { recursive: true });
  return LOCAL_BIN;
}

async function readToolVersion(toolId: RuntimeSecurityToolId): Promise<string | null> {
  const env = toolPathEnv();
  try {
    if (toolId === 'semgrep') {
      const out = await runCommand('semgrep', ['--version'], env);
      return out.split('\n')[0]?.trim() || null;
    }
    if (toolId === 'npm-audit') {
      const out = await runCommand('npm', ['--version'], env);
      return out.trim() || null;
    }
    if (toolId === 'gitleaks') {
      const out = await runCommand('gitleaks', ['version'], env);
      return out.trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function checkToolRuntimeAvailable(toolId: string): Promise<boolean> {
  if (!isRuntimeSecurityTool(toolId)) return true;
  if (toolId === 'semgrep') return isSemgrepAvailable();
  if (toolId === 'npm-audit') return isNpmAuditAvailable();
  if (toolId === 'gitleaks') return isGitleaksAvailable();
  return false;
}

export async function getToolRuntimeStatus(
  toolId: string,
  installedAt: Date | null | undefined,
  installedOs: string | null | undefined
): Promise<ToolRuntimeStatus> {
  const runtimeRequired = isRuntimeSecurityTool(toolId);
  const spec = getToolRuntimeSpec(toolId);
  const runtimeAvailable = runtimeRequired ? await checkToolRuntimeAvailable(toolId) : true;
  const version = runtimeRequired && runtimeAvailable ? await readToolVersion(toolId as RuntimeSecurityToolId) : null;
  const os =
    installedOs && isServerOsType(installedOs) ? installedOs : null;

  return {
    toolId,
    runtimeRequired,
    runtimeAvailable,
    runtimeReady: Boolean(installedAt),
    installedAt: installedAt?.toISOString() ?? null,
    installedOs: os,
    version,
    installCommands: os ? getInstallCommandsForOs(toolId, os) : [],
    installCommandsByOs: runtimeRequired ? getInstallCommandsByOs(toolId) : null,
  };
}

async function installWithBrew(packageName: string): Promise<void> {
  if (!(await hasCommand('brew'))) {
    throw new Error('Homebrew is not installed on this server.');
  }
  await runCommand('brew', ['install', packageName]);
}

async function installSemgrep(osType: ServerOsType): Promise<void> {
  if (await isSemgrepAvailable()) return;

  if (osType === 'macos') {
    if (await hasCommand('brew')) {
      await installWithBrew('semgrep');
      return;
    }
    await runCommand('pip3', ['install', 'semgrep']);
    return;
  }

  if (!(await hasCommand('pip3'))) {
    if (osType === 'ubuntu' && (await hasCommand('apt-get'))) {
      await runShell('sudo apt-get update && sudo apt-get install -y python3-pip');
    } else if (osType === 'linux') {
      await runShell('sudo yum install -y python3-pip || sudo dnf install -y python3-pip');
    }
  }

  await runCommand('pip3', ['install', '--user', 'semgrep']);
}

async function installNpmAuditRuntime(osType: ServerOsType): Promise<void> {
  if (await isNpmAuditAvailable()) return;

  if (osType === 'macos') {
    await installWithBrew('node');
    return;
  }

  if (osType === 'ubuntu' && (await hasCommand('apt-get'))) {
    await runShell('sudo apt-get update && sudo apt-get install -y nodejs npm');
    if (await isNpmAuditAvailable()) return;
  }

  if (osType === 'linux') {
    await runShell('sudo yum install -y nodejs npm || sudo dnf install -y nodejs npm');
    if (await isNpmAuditAvailable()) return;
  }

  if (await hasCommand('brew')) {
    await installWithBrew('node');
    return;
  }

  throw new Error('Node.js/npm could not be installed automatically. Run the manual commands shown in the dialog.');
}

async function installGitleaks(osType: ServerOsType): Promise<void> {
  if (await isGitleaksAvailable()) return;

  if (osType === 'macos') {
    await installWithBrew('gitleaks');
    return;
  }

  const binDir = await ensureLocalBin();
  const tarPath = path.join(os.tmpdir(), `gitleaks-${Date.now()}.tar.gz`);
  const downloadUrl =
    'https://github.com/gitleaks/gitleaks/releases/latest/download/gitleaks_linux_x64.tar.gz';

  try {
    await runShell(`wget -qO "${tarPath}" "${downloadUrl}" || curl -fsSL -o "${tarPath}" "${downloadUrl}"`);
    await runShell(`tar -xzf "${tarPath}" -C "${binDir}" gitleaks`);
    await fs.chmod(path.join(binDir, 'gitleaks'), 0o755);
  } finally {
    await fs.rm(tarPath, { force: true }).catch(() => undefined);
  }

  if (!(await isGitleaksAvailable())) {
    throw new Error('Gitleaks binary was downloaded but is not available on PATH.');
  }
}

export async function installToolRuntime(
  toolId: string,
  osType: ServerOsType
): Promise<{
  version: string | null;
  message: string;
}> {
  if (!isRuntimeSecurityTool(toolId)) {
    throw new Error('This tool does not require a server runtime installation.');
  }
  if (!isServerOsType(osType)) {
    throw new Error('Select a valid server OS type before installing.');
  }

  if (toolId === 'semgrep') await installSemgrep(osType);
  else if (toolId === 'npm-audit') await installNpmAuditRuntime(osType);
  else if (toolId === 'gitleaks') await installGitleaks(osType);

  const available = await checkToolRuntimeAvailable(toolId);
  if (!available) {
    throw new Error(
      `${getToolRuntimeSpec(toolId)?.name ?? toolId} installation finished but the CLI is still not available on PATH. Restart the SecureNexus server and try again.`
    );
  }

  const version = await readToolVersion(toolId);
  return {
    version,
    message: `${getToolRuntimeSpec(toolId)?.name ?? toolId} installed successfully on ${osType}${version ? ` (${version})` : ''}.`,
  };
}
