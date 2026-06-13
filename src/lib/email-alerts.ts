import nodemailer from 'nodemailer';
import type { ActivityAction } from '@/lib/activity';
import type { AlertConfigJson } from '@/lib/alert-settings';
import { getSmtpPassword } from '@/lib/alert-settings';
import { parseClusterDisplay } from '@/lib/utils';
import { formatAlertTarget, formatAlertTriggeredBy } from '@/lib/alert-display';

export interface EmailAlertPayload {
  title: string;
  message: string;
  action: ActivityAction;
  cluster: string;
  namespace: string;
  appName: string;
  triggeredBy: string;
  status: 'success' | 'failed';
  userName?: string;
  startTime?: string;
}

const ACTION_COLORS: Record<string, { bg: string; accent: string; emoji: string }> = {
  'schedule-run': { bg: '#eff6ff', accent: '#2563eb', emoji: '⚡' },
  'schedule-shutdown': { bg: '#fff7ed', accent: '#ea580c', emoji: '🌙' },
  'schedule-startup': { bg: '#ecfdf5', accent: '#059669', emoji: '☀️' },
  'scale-down': { bg: '#fef2f2', accent: '#dc2626', emoji: '⏬' },
  'scale-up': { bg: '#ecfdf5', accent: '#059669', emoji: '⏫' },
  'infra-shutdown': { bg: '#fff7ed', accent: '#ea580c', emoji: '🛑' },
  'infra-startup': { bg: '#ecfdf5', accent: '#059669', emoji: '🚀' },
  'sync-off': { bg: '#fffbeb', accent: '#d97706', emoji: '🔕' },
  'sync-on': { bg: '#ecfdf5', accent: '#059669', emoji: '🔔' },
};

function buildHtmlEmail(payload: EmailAlertPayload): string {
  const style = ACTION_COLORS[payload.action] ?? { bg: '#eff6ff', accent: '#2563eb', emoji: '🔔' };
  const { clusterName } = parseClusterDisplay(payload.cluster);
  const statusColor = payload.status === 'success' ? '#059669' : '#dc2626';
  const statusLabel = payload.status === 'success' ? 'Success' : 'Failed';
  const target = formatAlertTarget(payload.appName);
  const actor = formatAlertTriggeredBy(payload.triggeredBy, {
    userName: payload.userName,
    action: payload.action,
  });

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:${style.bg};padding:20px 24px;border-bottom:3px solid ${style.accent};">
      <div style="font-size:28px;margin-bottom:8px;">${style.emoji}</div>
      <h1 style="margin:0;font-size:20px;color:${style.accent};">${payload.title}</h1>
      <p style="margin:6px 0 0;font-size:12px;color:#71717a;">SecureNexus Alert</p>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 16px;font-size:15px;color:#18181b;line-height:1.5;">${payload.message}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><td style="padding:8px 0;color:#71717a;width:120px;">Status</td><td style="padding:8px 0;font-weight:600;color:${statusColor};">${statusLabel}</td></tr>
        ${payload.startTime ? `<tr><td style="padding:8px 0;color:#71717a;">Start Time</td><td style="padding:8px 0;color:#18181b;">${payload.startTime}</td></tr>` : ''}
        <tr><td style="padding:8px 0;color:#71717a;">Cluster</td><td style="padding:8px 0;color:#18181b;font-family:monospace;">${clusterName}</td></tr>
        <tr><td style="padding:8px 0;color:#71717a;">Namespace</td><td style="padding:8px 0;color:#18181b;font-family:monospace;">${payload.namespace}</td></tr>
        <tr><td style="padding:8px 0;color:#71717a;">Target</td><td style="padding:8px 0;color:#18181b;font-family:monospace;">${target}</td></tr>
        <tr><td style="padding:8px 0;color:#71717a;">Triggered by</td><td style="padding:8px 0;color:#18181b;">${actor}</td></tr>
      </table>
    </div>
    <div style="padding:16px 24px;background:#fafafa;border-top:1px solid #e4e4e7;font-size:11px;color:#a1a1aa;">
      Sent by SecureNexus Pod Scheduler
    </div>
  </div>
</body>
</html>`;
}

async function sendSmtpEmail(
  config: AlertConfigJson,
  password: string,
  to: string[],
  subject: string,
  html: string
): Promise<{ ok: boolean; message: string }> {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: password } : undefined,
  });

  await transporter.sendMail({
    from: config.emailFrom || config.smtpUser,
    to: to.join(', '),
    subject,
    html,
  });

  return { ok: true, message: `Email sent to ${to.length} recipient(s)` };
}

export async function sendEmailAlert(
  config: AlertConfigJson,
  payload: EmailAlertPayload,
  recipients?: string[]
): Promise<{ ok: boolean; message: string }> {
  const to = recipients ?? config.emailRecipients;
  if (!to.length) return { ok: false, message: 'No email recipients configured' };
  if (!config.smtpHost) return { ok: false, message: 'SMTP host is not configured' };

  const password = (await getSmtpPassword()) ?? '';
  const html = buildHtmlEmail(payload);
  const subject = `[SecureNexus] ${payload.title} — ${payload.status === 'success' ? 'Success' : 'Failed'}`;

  try {
    return await sendSmtpEmail(config, password, to, subject, html);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Failed to send email',
    };
  }
}
