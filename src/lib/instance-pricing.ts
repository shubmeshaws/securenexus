export type CapacityType = 'spot' | 'on-demand';

export interface InstanceSpec {
  vCpu: number;
  memoryGiB: number;
  /** On-demand USD per hour (us-east-1 approximate). */
  onDemandHourly: number;
}

/** Fraction of on-demand price for spot (override via COST_SPOT_MULTIPLIER). */
export const SPOT_MULTIPLIER = Number(process.env.COST_SPOT_MULTIPLIER) || 0.38;

/** Fallback when instance type is unknown. */
const DEFAULT_ON_DEMAND_HOURLY = Number(process.env.COST_DEFAULT_INSTANCE_HOURLY) || 0.096;
const DEFAULT_VCPU = 2;
const DEFAULT_MEMORY_GIB = 8;

/** Common EC2 instance on-demand $/hr (us-east-1, approximate). */
const ON_DEMAND_HOURLY: Record<string, number> = {
  't2.micro': 0.0116,
  't2.small': 0.023,
  't2.medium': 0.0464,
  't2.large': 0.0928,
  't3.micro': 0.0104,
  't3.small': 0.0208,
  't3.medium': 0.0416,
  't3.large': 0.0832,
  't3.xlarge': 0.1664,
  't3.2xlarge': 0.3328,
  'm5.large': 0.096,
  'm5.xlarge': 0.192,
  'm5.2xlarge': 0.384,
  'm5.4xlarge': 0.768,
  'm6i.large': 0.096,
  'm6i.xlarge': 0.192,
  'm6i.2xlarge': 0.384,
  'm6a.large': 0.0864,
  'm6a.xlarge': 0.1728,
  'c5.large': 0.085,
  'c5.xlarge': 0.17,
  'c5.2xlarge': 0.34,
  'c6i.large': 0.085,
  'c6i.xlarge': 0.17,
  'r5.large': 0.126,
  'r5.xlarge': 0.252,
  'r6i.large': 0.126,
  'r6i.xlarge': 0.252,
};

const SIZE_VCPU: Record<string, number> = {
  nano: 0.5,
  micro: 1,
  small: 1,
  medium: 2,
  large: 2,
  xlarge: 4,
  '2xlarge': 8,
  '4xlarge': 16,
  '8xlarge': 32,
  '12xlarge': 48,
  '16xlarge': 64,
  '24xlarge': 96,
};

function memoryGiBForFamily(family: string, vCpu: number): number {
  const f = family.charAt(0).toLowerCase();
  if (f === 'r') return vCpu * 8;
  if (f === 'c') return vCpu * 2;
  if (f === 't') return vCpu <= 1 ? 1 : vCpu * 2;
  return vCpu * 4;
}

export function parseInstanceSpec(instanceType: string): InstanceSpec {
  const normalized = instanceType.toLowerCase().trim();
  const known = ON_DEMAND_HOURLY[normalized];
  if (known) {
    const spec = KNOWN_SPECS[normalized];
    if (spec) return { ...spec, onDemandHourly: known };
  }

  const match = normalized.match(/^([a-z]+\d*[a-z]?)\.(.+)$/);
  if (match) {
    const [, family, sizeRaw] = match;
    const size = sizeRaw.replace(/_/g, '');
    const vCpu = SIZE_VCPU[size] ?? DEFAULT_VCPU;
    const memoryGiB = memoryGiBForFamily(family, vCpu);
    const onDemandHourly = known ?? estimateHourlyFromSize(family, vCpu, memoryGiB);
    return { vCpu, memoryGiB, onDemandHourly };
  }

  return {
    vCpu: DEFAULT_VCPU,
    memoryGiB: DEFAULT_MEMORY_GIB,
    onDemandHourly: DEFAULT_ON_DEMAND_HOURLY,
  };
}

const KNOWN_SPECS: Record<string, Omit<InstanceSpec, 'onDemandHourly'>> = {
  't3.medium': { vCpu: 2, memoryGiB: 4 },
  't3.large': { vCpu: 2, memoryGiB: 8 },
  't3.xlarge': { vCpu: 4, memoryGiB: 16 },
  'm5.large': { vCpu: 2, memoryGiB: 8 },
  'm5.xlarge': { vCpu: 4, memoryGiB: 16 },
  'm6i.large': { vCpu: 2, memoryGiB: 8 },
  'c5.large': { vCpu: 2, memoryGiB: 4 },
  'r5.large': { vCpu: 2, memoryGiB: 16 },
};

function estimateHourlyFromSize(family: string, vCpu: number, memoryGiB: number): number {
  const cpuRate = Number(process.env.COST_CPU_PER_VCORE_HOUR) || 0.0464;
  const memRate = Number(process.env.COST_MEM_PER_GB_HOUR) || 0.0058;
  const familyWeight = family.startsWith('c') ? 1.1 : family.startsWith('r') ? 1.25 : 1;
  return (vCpu * cpuRate + memoryGiB * memRate) * familyWeight;
}

export function hourlyPriceForInstance(
  instanceType: string,
  capacityType: CapacityType
): number {
  const spec = parseInstanceSpec(instanceType);
  const onDemand = spec.onDemandHourly;
  return capacityType === 'spot' ? onDemand * SPOT_MULTIPLIER : onDemand;
}

/** Split instance hourly price into per-vCPU and per-GiB rates (weighted by capacity). */
export function resourceRatesFromInstance(
  instanceType: string,
  capacityType: CapacityType
): { cpuHourlyPerCore: number; memHourlyPerGb: number; hourlyPrice: number; spec: InstanceSpec } {
  const spec = parseInstanceSpec(instanceType);
  const hourlyPrice = hourlyPriceForInstance(instanceType, capacityType);
  const computeWeight = spec.vCpu;
  const memWeight = spec.memoryGiB * 0.25;
  const total = computeWeight + memWeight || 1;

  return {
    spec,
    hourlyPrice,
    cpuHourlyPerCore: (hourlyPrice * computeWeight) / total / spec.vCpu,
    memHourlyPerGb: (hourlyPrice * memWeight) / total / spec.memoryGiB,
  };
}

export interface ClusterResourceRates {
  cpuHourlyPerCore: number;
  memHourlyPerGb: number;
}

export interface WeightedInstanceInput {
  instanceType: string;
  capacityType: CapacityType;
  count: number;
}

/** Cluster-wide weighted average $/vCPU-hr and $/GiB-hr from node instance mix. */
export function clusterResourceRates(instances: WeightedInstanceInput[]): ClusterResourceRates {
  let cpuWeighted = 0;
  let memWeighted = 0;
  let totalCpu = 0;
  let totalMem = 0;

  for (const row of instances) {
    const { cpuHourlyPerCore, memHourlyPerGb, spec } = resourceRatesFromInstance(
      row.instanceType,
      row.capacityType
    );
    const weight = row.count;
    cpuWeighted += cpuHourlyPerCore * spec.vCpu * weight;
    memWeighted += memHourlyPerGb * spec.memoryGiB * weight;
    totalCpu += spec.vCpu * weight;
    totalMem += spec.memoryGiB * weight;
  }

  if (totalCpu === 0 || totalMem === 0) {
    return {
      cpuHourlyPerCore: Number(process.env.COST_CPU_PER_VCORE_HOUR) || 0.0464,
      memHourlyPerGb: Number(process.env.COST_MEM_PER_GB_HOUR) || 0.0058,
    };
  }

  return {
    cpuHourlyPerCore: cpuWeighted / totalCpu,
    memHourlyPerGb: memWeighted / totalMem,
  };
}

export function detectCapacityType(labels: Record<string, string>): CapacityType {
  const eks = labels['eks.amazonaws.com/capacityType']?.toUpperCase();
  if (eks === 'SPOT') return 'spot';
  if (eks === 'ON_DEMAND') return 'on-demand';

  const eksAlt = labels['eks.amazonaws.com/capacity-type']?.toLowerCase();
  if (eksAlt === 'spot') return 'spot';
  if (eksAlt === 'on_demand' || eksAlt === 'on-demand') return 'on-demand';

  const karpenter = labels['karpenter.sh/capacity-type']?.toLowerCase();
  if (karpenter === 'spot') return 'spot';
  if (karpenter === 'on-demand') return 'on-demand';

  if (labels['node.kubernetes.io/lifecycle']?.toLowerCase() === 'spot') return 'spot';

  const ng = labels['eks.amazonaws.com/nodegroup']?.toLowerCase() ?? '';
  if (ng.includes('spot')) return 'spot';

  return 'on-demand';
}
