export type SecurityScanJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type SecurityReportMode = 'separate' | 'merged';

export interface SecurityScanJobView {
  id: string;
  resourceIds: string[];
  toolIds: string[];
  resourceNames: string[];
  toolNames: string[];
  status: SecurityScanJobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  reportCount: number;
  pairTotal: number;
  reportMode: SecurityReportMode;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
