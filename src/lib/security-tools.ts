export type SecurityToolCategory = 'sast' | 'sca' | 'dast' | 'iac' | 'secrets';

export interface SecurityToolDefinition {
  id: string;
  name: string;
  category: SecurityToolCategory;
  description: string;
  website: string;
  color: string;
  initials: string;
}

export const SECURITY_TOOL_CATEGORIES: {
  id: SecurityToolCategory;
  label: string;
  description: string;
}[] = [
  {
    id: 'sast',
    label: 'SAST',
    description: 'Static analysis — scan source code for vulnerabilities',
  },
  {
    id: 'sca',
    label: 'SCA',
    description: 'Software composition analysis — open-source dependency risk',
  },
  {
    id: 'dast',
    label: 'DAST',
    description: 'Dynamic analysis — test running applications',
  },
  {
    id: 'iac',
    label: 'IaC Security',
    description: 'Infrastructure-as-code misconfiguration scanning',
  },
  {
    id: 'secrets',
    label: 'Secrets',
    description: 'Detect leaked credentials and tokens in code',
  },
];

/** Free and open-source security tools catalog. */
export const SECURITY_TOOLS: SecurityToolDefinition[] = [
  // SAST
  {
    id: 'semgrep',
    name: 'Semgrep CE',
    category: 'sast',
    description: 'Fast static analysis for 30+ languages with custom YAML rules.',
    website: 'https://semgrep.dev',
    color: '#16a34a',
    initials: 'SG',
  },
  {
    id: 'sonarqube',
    name: 'SonarQube Community',
    category: 'sast',
    description: 'Code quality and security analysis for 30+ languages.',
    website: 'https://www.sonarqube.org',
    color: '#2563eb',
    initials: 'SQ',
  },
  {
    id: 'codeql',
    name: 'CodeQL',
    category: 'sast',
    description: 'Semantic code analysis with query-based rules (free for public repos).',
    website: 'https://codeql.github.com',
    color: '#1f2937',
    initials: 'CQ',
  },
  {
    id: 'opengrep',
    name: 'OpenGrep',
    category: 'sast',
    description: 'Community Semgrep fork with taint analysis and broad language support.',
    website: 'https://github.com/opengrep/opengrep',
    color: '#059669',
    initials: 'OG',
  },
  {
    id: 'bandit',
    name: 'Bandit',
    category: 'sast',
    description: 'Python-focused security linter for common vulnerability patterns.',
    website: 'https://bandit.readthedocs.io',
    color: '#ca8a04',
    initials: 'BD',
  },
  {
    id: 'brakeman',
    name: 'Brakeman',
    category: 'sast',
    description: 'Ruby on Rails static analysis with deep framework awareness.',
    website: 'https://brakemanscanner.org',
    color: '#dc2626',
    initials: 'BK',
  },
  {
    id: 'gosec',
    name: 'gosec',
    category: 'sast',
    description: 'Go security checker for common Go vulnerability classes.',
    website: 'https://github.com/securego/gosec',
    color: '#0ea5e9',
    initials: 'GS',
  },
  {
    id: 'phpstan',
    name: 'PHPStan',
    category: 'sast',
    description: 'PHP static analysis with progressive strictness levels.',
    website: 'https://phpstan.org',
    color: '#7c3aed',
    initials: 'PS',
  },
  {
    id: 'pmd',
    name: 'PMD',
    category: 'sast',
    description: 'Multi-language static analysis with 400+ rules including Java and JS.',
    website: 'https://pmd.github.io',
    color: '#4f46e5',
    initials: 'PM',
  },
  {
    id: 'horusec',
    name: 'Horusec',
    category: 'sast',
    description: 'Multi-tool orchestrator covering 18+ languages and IaC configs.',
    website: 'https://horusec.io',
    color: '#9333ea',
    initials: 'HR',
  },
  // SCA
  {
    id: 'trivy',
    name: 'Trivy',
    category: 'sca',
    description: 'All-in-one scanner for dependencies, containers, IaC, and secrets.',
    website: 'https://trivy.dev',
    color: '#0891b2',
    initials: 'TV',
  },
  {
    id: 'grype',
    name: 'Grype',
    category: 'sca',
    description: 'Focused vulnerability scanner with EPSS and KEV risk scoring.',
    website: 'https://github.com/anchore/grype',
    color: '#0d9488',
    initials: 'GP',
  },
  {
    id: 'osv-scanner',
    name: 'OSV-Scanner',
    category: 'sca',
    description: 'Google-backed scanner using the OSV.dev vulnerability database.',
    website: 'https://google.github.io/osv-scanner',
    color: '#ea4335',
    initials: 'OS',
  },
  {
    id: 'dependency-check',
    name: 'OWASP Dependency-Check',
    category: 'sca',
    description: 'OWASP flagship SCA with native Maven and Gradle integration.',
    website: 'https://owasp.org/www-project-dependency-check',
    color: '#b45309',
    initials: 'DC',
  },
  {
    id: 'syft',
    name: 'Syft',
    category: 'sca',
    description: 'SBOM generator for CycloneDX and SPDX supply-chain visibility.',
    website: 'https://github.com/anchore/syft',
    color: '#7c3aed',
    initials: 'SY',
  },
  {
    id: 'npm-audit',
    name: 'npm audit',
    category: 'sca',
    description: 'Built-in npm CLI scanner for Node.js dependency vulnerabilities in package-lock.json.',
    website: 'https://docs.npmjs.com/cli/v10/commands/npm-audit',
    color: '#cb3837',
    initials: 'NA',
  },
  // DAST
  {
    id: 'zap',
    name: 'OWASP ZAP',
    category: 'dast',
    description: 'Industry-standard open-source web application security scanner.',
    website: 'https://www.zaproxy.org',
    color: '#dc2626',
    initials: 'ZP',
  },
  {
    id: 'nuclei',
    name: 'Nuclei',
    category: 'dast',
    description: 'Template-based scanner with 12,000+ community CVE and misconfig checks.',
    website: 'https://github.com/projectdiscovery/nuclei',
    color: '#6366f1',
    initials: 'NU',
  },
  {
    id: 'nikto',
    name: 'Nikto',
    category: 'dast',
    description: 'Fast web server scanner with thousands of security checks.',
    website: 'https://github.com/sullo/nikto',
    color: '#15803d',
    initials: 'NK',
  },
  {
    id: 'wapiti',
    name: 'Wapiti',
    category: 'dast',
    description: 'Python black-box web fuzzer for XSS, SQLi, and XXE detection.',
    website: 'https://wapiti-scanner.github.io',
    color: '#c2410c',
    initials: 'WP',
  },
  // IaC
  {
    id: 'checkov',
    name: 'Checkov',
    category: 'iac',
    description: 'Terraform, CloudFormation, Kubernetes, and Dockerfile policy checks.',
    website: 'https://www.checkov.io',
    color: '#6366f1',
    initials: 'CK',
  },
  {
    id: 'kics',
    name: 'KICS',
    category: 'iac',
    description: 'Keeping Infrastructure as Code Secure — multi-cloud IaC scanner.',
    website: 'https://github.com/Checkmarx/kics',
    color: '#0284c7',
    initials: 'KI',
  },
  // Secrets
  {
    id: 'gitleaks',
    name: 'Gitleaks',
    category: 'secrets',
    description: 'Detect hard-coded secrets in git repos and CI pipelines.',
    website: 'https://gitleaks.io',
    color: '#f59e0b',
    initials: 'GL',
  },
  {
    id: 'detect-secrets',
    name: 'detect-secrets',
    category: 'secrets',
    description: 'Baseline secret scanning that flags new secrets without blocking legacy ones.',
    website: 'https://github.com/Yelp/detect-secrets',
    color: '#d97706',
    initials: 'DS',
  },
];

export function getSecurityToolById(toolId: string): SecurityToolDefinition | undefined {
  return SECURITY_TOOLS.find((tool) => tool.id === toolId);
}

export function securityToolsByCategory(category: SecurityToolCategory): SecurityToolDefinition[] {
  return SECURITY_TOOLS.filter((tool) => tool.category === category);
}

export function isToolCompatibleWithResourceType(
  resourceType: 'repository' | 'target_url',
  category: SecurityToolCategory
): boolean {
  if (resourceType === 'target_url') return category === 'dast';
  return category !== 'dast';
}

export function availableCategoriesForResourceTypes(
  types: Array<'repository' | 'target_url'>
): SecurityToolCategory[] {
  const hasRepo = types.includes('repository');
  const hasUrl = types.includes('target_url');

  if (hasUrl && !hasRepo) {
    return ['dast'];
  }
  if (hasRepo && !hasUrl) {
    return ['sast', 'sca', 'iac', 'secrets'];
  }
  if (hasRepo && hasUrl) {
    return ['sast', 'sca', 'iac', 'secrets', 'dast'];
  }
  return [];
}

export function compatibleToolsForResource(
  type: 'repository' | 'target_url',
  enabledToolIds: Set<string>,
  categories?: SecurityToolCategory[]
): SecurityToolDefinition[] {
  return SECURITY_TOOLS.filter((tool) => {
    if (!enabledToolIds.has(tool.id)) return false;
    if (categories?.length && !categories.includes(tool.category)) return false;
    return isToolCompatibleWithResourceType(type, tool.category);
  });
}

export function compatibleToolsForResources(
  resources: Array<{ type: 'repository' | 'target_url' }>,
  enabledToolIds: Set<string>,
  categories: SecurityToolCategory[]
): SecurityToolDefinition[] {
  const seen = new Set<string>();
  const tools: SecurityToolDefinition[] = [];
  for (const resource of resources) {
    for (const tool of compatibleToolsForResource(resource.type, enabledToolIds, categories)) {
      if (!seen.has(tool.id)) {
        seen.add(tool.id);
        tools.push(tool);
      }
    }
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveScanPairs(input: {
  resources: Array<{ id: string; type: 'repository' | 'target_url' }>;
  toolIds: string[];
  enabledToolIds: Set<string>;
}): Array<{ resourceId: string; toolId: string }> {
  const pairs: Array<{ resourceId: string; toolId: string }> = [];
  for (const resource of input.resources) {
    for (const toolId of input.toolIds) {
      const tool = getSecurityToolById(toolId);
      if (!tool || !input.enabledToolIds.has(toolId)) continue;
      if (!isToolCompatibleWithResourceType(resource.type, tool.category)) continue;
      pairs.push({ resourceId: resource.id, toolId });
    }
  }
  return pairs;
}
