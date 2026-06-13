import PDFDocument from 'pdfkit';
import type { ActivityLog } from '@prisma/client';
import { formatTimestampIST } from '@/lib/utils';
import { activityActorLabel, formatAlertTarget } from '@/lib/alert-display';

const ACTION_LABELS: Record<string, string> = {
  'sync-off': 'Sync Off',
  'sync-on': 'Sync On',
  'scale-down': 'Scale Down',
  'scale-up': 'Scale Up',
  'schedule-run': 'Schedule Run',
  'schedule-shutdown': 'Scheduled Shutdown',
  'schedule-startup': 'Scheduled Startup',
  'infra-shutdown': 'Infrastructure Stopped',
  'infra-startup': 'Infrastructure Started',
};

const STATUS_COLORS: Record<string, string> = {
  success: '#15803d',
  failed: '#dc2626',
};

const ROW_ALT = '#f1f5f9';
const ROW_BASE = '#ffffff';
const HEADER_BG = '#0f172a';
const HEADER_FG = '#f8fafc';

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

type ActivityLogRow = ActivityLog & {
  userName?: string | null;
  userEmail?: string | null;
};

function actorForLog(log: ActivityLogRow): string {
  return activityActorLabel(log.triggeredBy, {
    userName: log.userName,
    action: log.action,
  });
}

export function activityLogsToCsv(logs: ActivityLogRow[]): string {
  const headers = [
    'Timestamp (IST)',
    'Action',
    'Status',
    'User',
    'Cluster',
    'Namespace',
    'Target',
    'Message',
    'IP Address',
  ];

  const rows = logs.map((log) => {
    const target = formatAlertTarget(log.appName);
    const actor = actorForLog(log);
    return [
      formatTimestampIST(log.timestamp.toISOString()),
      actionLabel(log.action),
      log.status,
      actor,
      log.cluster,
      log.namespace,
      target,
      log.message ?? '',
      log.ipAddress ?? '',
    ]
      .map((v) => csvEscape(String(v)))
      .join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

const PDF_COLUMNS = [
  { key: 'timestamp', label: 'Timestamp (IST)', width: 108 },
  { key: 'user', label: 'User', width: 72 },
  { key: 'action', label: 'Action', width: 88 },
  { key: 'target', label: 'Target', width: 88 },
  { key: 'status', label: 'Status', width: 48 },
  { key: 'message', label: 'Details', width: 128 },
] as const;

const TABLE_LEFT = 36;
const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 26;

function truncateText(doc: InstanceType<typeof PDFDocument>, text: string, maxWidth: number): string {
  if (!text) return '—';
  if (doc.widthOfString(text) <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 1 && doc.widthOfString(`${trimmed}…`) > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}…`;
}

export function activityLogsToPdfBuffer(
  logs: ActivityLogRow[],
  meta?: { from?: string; to?: string }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
    const chunks: Buffer[] = [];
    const pageWidth = doc.page.width - 72;

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).fillColor('#0f172a').text('SecureNexus Activity Logs', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#64748b');
    doc.text(`Generated: ${formatTimestampIST(new Date().toISOString())}`);
    if (meta?.from || meta?.to) {
      doc.text(
        `Range: ${meta.from ?? '—'} → ${meta.to ?? '—'}`
      );
    }
    doc.text(`Records: ${logs.length}`);
    doc.moveDown(0.8);

    const drawHeader = (y: number) => {
      doc.rect(TABLE_LEFT, y, pageWidth, HEADER_HEIGHT).fill(HEADER_BG);
      let x = TABLE_LEFT + 6;
      doc.fontSize(7).fillColor(HEADER_FG);
      for (const col of PDF_COLUMNS) {
        doc.text(col.label, x, y + 8, { width: col.width - 8, lineBreak: false });
        x += col.width;
      }
    };

    let y = doc.y;
    drawHeader(y);
    y += HEADER_HEIGHT;

    logs.forEach((log, index) => {
      if (y + ROW_HEIGHT > doc.page.height - 48) {
        doc.addPage({ layout: 'landscape', margin: 36 });
        y = 36;
        drawHeader(y);
        y += HEADER_HEIGHT;
      }

      const bg = index % 2 === 0 ? ROW_BASE : ROW_ALT;
      doc.rect(TABLE_LEFT, y, pageWidth, ROW_HEIGHT).fill(bg);

      const target = formatAlertTarget(log.appName);
      const actor = actorForLog(log);
      const values = [
        formatTimestampIST(log.timestamp.toISOString()),
        actor,
        actionLabel(log.action),
        target,
        log.status,
        log.message ?? '—',
      ];

      let x = TABLE_LEFT + 6;
      doc.fontSize(7);
      values.forEach((value, colIndex) => {
        const col = PDF_COLUMNS[colIndex];
        const color =
          col.key === 'status'
            ? (STATUS_COLORS[log.status] ?? '#334155')
            : '#1e293b';
        doc.fillColor(color);
        doc.text(truncateText(doc, value, col.width - 10), x, y + 7, {
          width: col.width - 10,
          lineBreak: false,
        });
        x += col.width;
      });

      y += ROW_HEIGHT;
    });

    doc.end();
  });
}
