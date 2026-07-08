/** Map a numeric CVSS base score (0–10) to a severity label. */
export function severityFromCvssScore(score: number): string {
  if (score >= 9) return 'Critical';
  if (score >= 7) return 'High';
  if (score >= 4) return 'Medium';
  if (score > 0) return 'Low';
  return 'Info';
}

const METRIC_VALUES: Record<string, Record<string, number>> = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { N: 0, L: 0.22, H: 0.56 },
};

function prValue(scope: string, pr: string): number {
  if (scope === 'C') {
    return { N: 0.85, L: 0.68, H: 0.5 }[pr] ?? 0.85;
  }
  return { N: 0.85, L: 0.62, H: 0.27 }[pr] ?? 0.85;
}

function roundUp1(value: number): number {
  return Math.ceil(value * 10) / 10;
}

/**
 * Compute CVSS v3.0/v3.1 base score from a vector string such as
 * `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N`.
 * Returns undefined when the vector cannot be parsed.
 */
export function cvssBaseScoreFromVector(vector: string): number | undefined {
  const trimmed = vector.trim();
  if (!trimmed.startsWith('CVSS:')) return undefined;

  const metrics: Record<string, string> = {};
  for (const part of trimmed.split('/').slice(1)) {
    const [key, value] = part.split(':');
    if (key && value) metrics[key] = value;
  }

  const av = metrics.AV;
  const ac = metrics.AC;
  const pr = metrics.PR;
  const ui = metrics.UI;
  const scope = metrics.S;
  const c = metrics.C;
  const i = metrics.I;
  const a = metrics.A;

  if (!av || !ac || !pr || !ui || !scope || !c || !i || !a) return undefined;

  const exploitability =
    8.22 *
    (METRIC_VALUES.AV[av] ?? 0) *
    (METRIC_VALUES.AC[ac] ?? 0) *
    prValue(scope, pr) *
    (METRIC_VALUES.UI[ui] ?? 0);

  const cia = METRIC_VALUES.CIA;
  const iss = 1 - (1 - (cia[c] ?? 0)) * (1 - (cia[i] ?? 0)) * (1 - (cia[a] ?? 0));
  const impact =
    scope === 'U'
      ? 6.42 * iss
      : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;

  if (impact <= 0) return 0;
  return roundUp1(Math.min(impact + exploitability, 10));
}

/** Derive severity from a CVSS vector or numeric score string. */
export function severityFromCvssValue(score: string): string | undefined {
  const trimmed = score.trim();
  if (!trimmed) return undefined;

  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric)) return severityFromCvssScore(numeric);

  const base = cvssBaseScoreFromVector(trimmed);
  return base === undefined ? undefined : severityFromCvssScore(base);
}
