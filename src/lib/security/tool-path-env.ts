import os from 'os';
import path from 'path';

export function extendedToolPath(): string {
  return [
    path.join(process.cwd(), '.securenexus', 'bin'),
    path.join(os.homedir(), '.local', 'bin'),
    process.env.PATH ?? '',
  ]
    .filter(Boolean)
    .join(':');
}

export function toolPathEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: extendedToolPath(),
  };
}
