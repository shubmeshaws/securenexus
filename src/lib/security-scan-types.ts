export type SecurityScanJobStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type SecurityReportMode = 'separate' | 'merged';

export interface SecurityScanJobReportView {
  id: string;
  title: string;
  toolName: string;
}

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
  reports: SecurityScanJobReportView[];
  pairTotal: number;
  reportMode: SecurityReportMode;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
