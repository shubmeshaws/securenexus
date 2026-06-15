import { getApiBaseUrl } from '@/lib/client-settings';

export { isDemoMode } from '@/lib/client-settings';

function formatApiError(error: unknown, status: number, message?: string): string {
  if (typeof message === 'string' && message.trim()) return message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const flattened = error as {
      formErrors?: string[];
      fieldErrors?: Record<string, string[]>;
    };
    const messages = [
      ...(flattened.formErrors ?? []),
      ...Object.entries(flattened.fieldErrors ?? {}).flatMap(([field, msgs]) =>
        msgs.map((msg) => `${field}: ${msg}`)
      ),
    ];
    if (messages.length > 0) return messages.join('; ');
  }
  return `Request failed: ${status}`;
}

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('sn_token');
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: unknown;
      message?: string;
    };
    throw new Error(formatApiError(body.error, res.status, body.message));
  }

  return res.json() as Promise<T>;
}

export interface Schedule {
  id: string;
  name: string;
  platformType: 'eks' | 'non_eks';
  cluster: string;
  namespace: string;
  scope: 'workload' | 'namespace';
  appName: string;
  workloadKind: string;
  excludedWorkloads: string[];
  awsCredentialId: string | null;
  ec2InstanceId: string | null;
  ec2Region: string | null;
  awsAccountId?: string | null;
  shutdownTime: string;
  startupTime: string;
  recurrence: 'daily' | 'onetime';
  oneTimeShutdownAt: string | null;
  oneTimeStartupAt: string | null;
  oneTimeCompleted: boolean;
  timezone: string;
  daysOfWeek: number[];
  syncPolicy: 'automated' | 'none';
  argocdInstanceId: string | null;
  targetReplicas: number;
  enabled: boolean;
  teamsAlertEnabled: boolean;
  liveActive: boolean;
  savedReplicas: number | null;
  lastRun: string | null;
  nextRun: string | null;
}

export interface ArgoCDApp {
  name: string;
  namespace: string;
  cluster: string;
  syncStatus: 'Synced' | 'OutOfSync' | 'Unknown' | 'Progressing';
  healthStatus: string;
  syncPolicy: 'automated' | 'none';
  lastSyncedAt: string | null;
  destinationNamespace: string;
  instanceId: string;
  instanceName: string;
}

export interface ArgoCDInstance {
  id: string;
  name: string;
  serverUrl: string;
  tokenSet: boolean;
  insecureTls: boolean;
  enabled: boolean;
  clusterNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Deployment {
  name: string;
  namespace: string;
  cluster: string;
  replicas: number;
  readyReplicas: number;
  availableReplicas: number;
  desiredReplicas: number;
  pods?: Pod[];
}

export interface Pod {
  name: string;
  namespace: string;
  status: string;
  ready: string;
  restarts: number;
  age: string;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: string;
  action: string;
  cluster: string;
  namespace: string;
  appName: string;
  triggeredBy: string;
  status: 'success' | 'failed';
  message: string | null;
  userId?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  userRole?: string | null;
  ipAddress?: string | null;
  resourceType?: string | null;
  details?: string | null;
}

export interface RegisteredCluster {
  id: string;
  name: string;
  provider: 'kubeconfig' | 'aws';
  region: string | null;
  status: 'connected' | 'disconnected' | 'error';
  contextName: string | null;
  kubeconfigPath: string | null;
  serverUrl: string | null;
  awsClusterName: string | null;
  addedBy: string | null;
  addedByName: string | null;
  lastSyncAt: string | null;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'analyst' | 'viewer';
  active: boolean;
  lastLogin: string | null;
  createdAt: string;
  permissions?: {
    scheduleEdit: boolean;
    scheduleStart: boolean;
    scheduleStop: boolean;
    liveScheduleStop: boolean;
  };
}

export interface EnvironmentHoursSummary {
  state: 'running' | 'stopped';
  stateSince: string;
  runningHours: number;
  stoppedHours: number;
}

export interface DashboardInsights {
  namespaceStopped: {
    cluster: string;
    namespace: string;
    stoppedHours: number;
    stoppedMs: number;
  }[];
  instanceTypes: {
    cluster: string;
    instanceType: string;
    capacityType: 'spot' | 'on-demand';
    count: number;
    vCpu: number;
    memoryGiB: number;
    hourlyPrice: number;
    cpuRatePerCore: number;
    memRatePerGb: number;
  }[];
  costSavings: {
    cluster: string;
    namespace: string;
    stoppedHours: number;
    stoppedHoursToday: number;
    stoppedHoursMonth: number;
    cpuCores: number;
    memoryGb: number;
    cpuSavedTotal: number;
    memorySavedTotal: number;
    cpuSavedPerDay: number;
    memorySavedPerDay: number;
    cpuSavedPerMonth: number;
    memorySavedPerMonth: number;
  }[];
  costCalendarTz?: string;
  totals: {
    stoppedHours: number;
    stoppedHoursToday: number;
    stoppedHoursMonth: number;
    cpuSavedTotal: number;
    memorySavedTotal: number;
    cpuSavedPerDay: number;
    memorySavedPerDay: number;
    cpuSavedPerMonth: number;
    memorySavedPerMonth: number;
  };
}

export interface OverviewData {
  summary: {
    totalApps: number;
    running: number;
    stopped: number;
    scheduled: number;
    connectedClusters: number;
    runningHours?: number;
    stoppedHours?: number;
    environmentState?: 'running' | 'stopped';
  };
  environment?: EnvironmentHoursSummary;
  activeSchedules: Schedule[];
  insights?: DashboardInsights;
  k8sDegraded?: boolean;
  k8sMessage?: string;
  argocdDegraded: boolean;
  argocdMessage?: string;
}

export type InfraState = 'running' | 'stopped' | 'partial' | 'starting' | 'stopping';

export interface NodeGroupInfo {
  name: string;
  desired: number;
  min: number;
  max: number;
  status: 'active' | 'scaling' | 'stopped';
}

export interface InfrastructureCluster {
  id: string;
  name: string;
  provider: 'kubeconfig' | 'aws';
  region: string | null;
  awsClusterName: string | null;
  status: 'connected' | 'disconnected' | 'error';
  infraState: InfraState;
  nodeGroups: NodeGroupInfo[];
  workloads: { total: number; running: number; stopped: number };
  activeSchedules: number;
  estimatedSavingsPct: number;
  lastAction: string | null;
  lastActionAt: string | null;
}

export interface InfrastructureOverview {
  clusters: InfrastructureCluster[];
  summary: {
    total: number;
    running: number;
    stopped: number;
    partial: number;
  };
}
