type TrufflehogReleaseAsset = {
  name: string;
  browser_download_url: string;
};

function trufflehogAssetSuffix(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin_arm64.tar.gz' : 'darwin_amd64.tar.gz';
  }
  return process.arch === 'arm64' ? 'linux_arm64.tar.gz' : 'linux_amd64.tar.gz';
}

export async function resolveTrufflehogDownloadUrl(): Promise<string> {
  const suffix = trufflehogAssetSuffix();
  const response = await fetch(
    'https://api.github.com/repos/trufflesecurity/trufflehog/releases/latest',
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'SecureNexus',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to resolve the latest TruffleHog release (HTTP ${response.status}).`);
  }

  const payload = (await response.json()) as { assets?: TrufflehogReleaseAsset[] };
  const asset = payload.assets?.find((row) => row.name.endsWith(suffix));
  if (!asset?.browser_download_url) {
    throw new Error(`TruffleHog release asset not found for ${suffix}.`);
  }

  return asset.browser_download_url;
}

export function trufflehogInstallCommandHint(os: 'ubuntu' | 'linux' | 'macos'): string[] {
  if (os === 'macos') {
    return ['brew install trufflehog'];
  }

  const arch = process.arch === 'arm64' ? 'linux_arm64' : 'linux_amd64';
  return [
    'SecureNexus downloads the latest TruffleHog release from GitHub automatically',
    `Extracts trufflehog_*_${arch}.tar.gz into .securenexus/bin/`,
  ];
}
