import * as k8s from '@kubernetes/client-node';
import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_KUBECONFIG_BYTES = 1024 * 1024;

export class KubeconfigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KubeconfigFileError';
  }
}

export function resolveKubeconfigPath(userPath: string): string {
  const trimmed = userPath.trim();
  if (!trimmed || trimmed.includes('\0')) {
    throw new KubeconfigFileError('Invalid kubeconfig path');
  }

  const expanded = trimmed.startsWith('~')
    ? path.join(os.homedir(), trimmed.slice(1).replace(/^\//, ''))
    : trimmed;

  const resolved = path.resolve(expanded);
  const home = path.resolve(os.homedir());

  if (!resolved.startsWith(home + path.sep) && resolved !== home) {
    throw new KubeconfigFileError('Kubeconfig path must be under your home directory');
  }

  return resolved;
}

export interface KubeconfigContextInfo {
  name: string;
  cluster: string;
  server: string | null;
  user: string | null;
  isCurrent: boolean;
}

export interface KubeconfigFileResult {
  resolvedPath: string;
  kubeconfigB64: string;
  contexts: KubeconfigContextInfo[];
  currentContext: string | null;
}

export function readKubeconfigFromPath(userPath: string): KubeconfigFileResult {
  const resolvedPath = resolveKubeconfigPath(userPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new KubeconfigFileError(`Kubeconfig file not found at ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new KubeconfigFileError('Path is not a file');
  }

  if (stat.size > MAX_KUBECONFIG_BYTES) {
    throw new KubeconfigFileError('Kubeconfig file is too large');
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  if (!content.trim()) {
    throw new KubeconfigFileError('Kubeconfig file is empty');
  }

  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromString(content);
  } catch {
    throw new KubeconfigFileError('Invalid kubeconfig file format');
  }

  const currentContext = kc.getCurrentContext() || null;
  const contexts = kc
    .getContexts()
    .filter((ctx) => Boolean(ctx.name))
    .map((ctx) => {
      const clusterRef = ctx.cluster ?? ctx.name;
      const clusterObj = kc.clusters.find((c) => c.name === clusterRef);
      return {
        name: ctx.name as string,
        cluster: clusterRef as string,
        server: clusterObj?.server ?? null,
        user: ctx.user ?? null,
        isCurrent: ctx.name === currentContext,
      };
    });

  return {
    resolvedPath,
    kubeconfigB64: Buffer.from(content, 'utf-8').toString('base64'),
    contexts,
    currentContext,
  };
}
