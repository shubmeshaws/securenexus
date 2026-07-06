function extractHttpStatus(scanOutput: string): number | null {
  const match = scanOutput.match(/received a (\d{3}) response code/i);
  if (!match?.[1]) return null;
  const code = Number.parseInt(match[1], 10);
  return Number.isFinite(code) ? code : null;
}

function cloudflare522Message(targetUrl: string): string {
  return (
    `ZAP could not scan ${targetUrl}: the target returned HTTP 522 (Cloudflare connection timeout) from this SecureNexus server. ` +
    `This usually means Cloudflare or the origin cannot be reached from this EC2 instance's outbound IP. ` +
    `Scans may work from other servers (different egress IP) but fail here. ` +
    `Allow this server's public IP in Cloudflare/WAF, security groups, or network ACLs, then retry.`
  );
}

export function detectZapScanFailure(scanOutput: string, targetUrl: string): string | null {
  const output = scanOutput.trim();
  if (!output) return null;

  if (/Failed to attack the URL/i.test(output)) {
    const status = extractHttpStatus(output);
    if (status === 522) return cloudflare522Message(targetUrl);
    if (status === 403) {
      return `ZAP could not scan ${targetUrl}: HTTP 403 Forbidden from this server. The target may block this EC2 instance's IP.`;
    }
    if (status === 401) {
      return `ZAP could not scan ${targetUrl}: HTTP 401 Unauthorized. Authentication may be required before scanning.`;
    }
    if (status && status >= 500) {
      return `ZAP could not scan ${targetUrl}: HTTP ${status} from this server. The target is not returning a successful response to this EC2 instance.`;
    }
    if (status) {
      return `ZAP could not scan ${targetUrl}: received HTTP ${status}, expected 2xx. The URL is not reachable from this SecureNexus server.`;
    }
    return `ZAP could not attack ${targetUrl} from this server. Check network access, DNS, TLS, and firewall rules.`;
  }

  if (/No URLs found/i.test(output)) {
    return `ZAP found no URLs for ${targetUrl}. The target may be unreachable from this SecureNexus server.`;
  }

  return null;
}

export function interpretReachabilityStatus(statusCode: number, targetUrl: string): string | null {
  if (statusCode >= 200 && statusCode < 400) return null;
  if (statusCode === 522) return cloudflare522Message(targetUrl);
  if (statusCode === 403) {
    return `Preflight check: ${targetUrl} returned HTTP 403 from this server. The target may block this EC2 egress IP.`;
  }
  if (statusCode === 0) {
    return `Preflight check: could not connect to ${targetUrl} from this server (timeout or DNS failure).`;
  }
  if (statusCode >= 500) {
    return `Preflight check: ${targetUrl} returned HTTP ${statusCode} from this server before ZAP started.`;
  }
  return `Preflight check: ${targetUrl} returned HTTP ${statusCode} from this server (expected 2xx).`;
}
