/** Parse Kubernetes CPU quantity to cores (e.g. 250m → 0.25, 2 → 2). */
export function parseCpuToCores(value: string | undefined | null): number {
  if (!value) return 0;
  const v = value.trim();
  if (v.endsWith('m')) {
    const milli = parseFloat(v.slice(0, -1));
    return Number.isFinite(milli) ? milli / 1000 : 0;
  }
  const cores = parseFloat(v);
  return Number.isFinite(cores) ? cores : 0;
}

/** Parse Kubernetes memory quantity to GiB. */
export function parseMemoryToGiB(value: string | undefined | null): number {
  if (!value) return 0;
  const v = value.trim();
  const match = v.match(/^([\d.]+)(Ki|Mi|Gi|Ti|K|M|G|T)?$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num)) return 0;
  const unit = (match[2] ?? '').toLowerCase();

  const bytesPerGiB = 1024 ** 3;
  let bytes = num;
  switch (unit) {
    case 'ki':
      bytes = num * 1024;
      break;
    case 'mi':
      bytes = num * 1024 ** 2;
      break;
    case 'gi':
      bytes = num * 1024 ** 3;
      break;
    case 'ti':
      bytes = num * 1024 ** 4;
      break;
    case 'k':
      bytes = num * 1000;
      break;
    case 'm':
      bytes = num * 1000 ** 2;
      break;
    case 'g':
      bytes = num * 1000 ** 3;
      break;
    case 't':
      bytes = num * 1000 ** 4;
      break;
    default:
      bytes = num;
  }
  return bytes / bytesPerGiB;
}

export function formatCpuDisplay(cores: number): string {
  if (cores === 0) return '0';
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  return Number.isInteger(cores) ? String(cores) : cores.toFixed(2);
}

export function formatMemoryDisplay(gib: number): string {
  if (gib === 0) return '0';
  if (gib < 1) return `${Math.round(gib * 1024)}Mi`;
  return `${gib.toFixed(gib < 10 ? 2 : 1)}Gi`;
}
