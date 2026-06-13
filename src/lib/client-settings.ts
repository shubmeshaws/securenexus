let demoMode = false;
let apiBaseUrl = '';

export function setClientSettings(settings: { demoMode: boolean; apiBaseUrl: string }) {
  demoMode = settings.demoMode;
  apiBaseUrl = settings.apiBaseUrl;
}

export function isDemoMode(): boolean {
  return demoMode;
}

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}
