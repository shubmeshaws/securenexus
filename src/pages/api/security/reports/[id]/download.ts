import type { NextApiResponse } from 'next';
import { requireAdmin, methodNotAllowed, type AuthenticatedRequest } from '@/lib/auth';
import { getSecurityReportHtml, getSecurityReportPdfBuffer, getSecurityReportCsv } from '@/lib/security-service';

async function getHandler(req: AuthenticatedRequest, res: NextApiResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  const format = typeof req.query.format === 'string' ? req.query.format : 'html';
  if (!id) return res.status(400).json({ error: 'Missing report id' });

  try {
    if (format === 'pdf') {
      const { title, buffer } = await getSecurityReportPdfBuffer(id);
      const filename = `${title.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.status(200).send(buffer);
    }

    if (format === 'csv') {
      const { title, csv } = await getSecurityReportCsv(id);
      const filename = `${title.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.status(200).send(csv);
    }

    const { title, html } = await getSecurityReportHtml(id);
    const filename = `${title.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(html);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to download report';
    return res.status(400).json({ error: message });
  }
}

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  return methodNotAllowed(res, ['GET']);
}

export default requireAdmin(handler);
