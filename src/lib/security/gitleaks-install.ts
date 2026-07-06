type GitleaksReleaseAsset = {
  name: string;
  browser_download_url: string;
};

function gitleaksAssetSuffix(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin_arm64.tar.gz' : 'darwin_x64.tar.gz';
  }
  return process.arch === 'arm64' ? 'linux_arm64.tar.gz' : 'linux_x64.tar.gz';
}

export async function resolveGitleaksDownloadUrl(): Promise<string> {
  const suffix = gitleaksAssetSuffix();
  const response = await fetch('https://api.github.com/repos/gitleaks/gitleaks/releases/latest', {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'SecureNexus',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to resolve the latest Gitleaks release (HTTP ${response.status}).`);
  }

  const payload = (await response.json()) as { assets?: GitleaksReleaseAsset[] };
  const asset = payload.assets?.find((row) => row.name.endsWith(suffix));
  if (!asset?.browser_download_url) {
    throw new Error(`Gitleaks release asset not found for ${suffix}.`);
  }

  return asset.browser_download_url;
}

export function gitleaksInstallCommandHint(os: 'ubuntu' | 'linux' | 'macos'): string[] {
  if (os === 'macos') {
    return ['brew install gitleaks'];
  }

  const arch = process.arch === 'arm64' ? 'linux_arm64' : 'linux_x64';
  return [
    'SecureNexus downloads the latest Gitleaks release from GitHub automatically',
    `Extracts gitleaks_*_${arch}.tar.gz into .securenexus/bin/`,
  ];
}
