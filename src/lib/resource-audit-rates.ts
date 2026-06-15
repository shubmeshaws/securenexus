import { clusterResourceRates, type ClusterResourceRates } from './instance-pricing';
import { listClusterInstanceTypes } from './k8s-client';

export async function getClusterResourceRates(
  cluster: string,
  cache: Map<string, ClusterResourceRates>
): Promise<ClusterResourceRates> {
  const cached = cache.get(cluster);
  if (cached) return cached;
  try {
    const instances = await listClusterInstanceTypes(cluster);
    const rates = clusterResourceRates(
      instances.map((row) => ({
        instanceType: row.instanceType,
        capacityType: row.capacityType,
        count: row.count,
      }))
    );
    cache.set(cluster, rates);
    return rates;
  } catch {
    const fallback = {
      cpuHourlyPerCore: Number(process.env.COST_CPU_PER_VCORE_HOUR) || 0.0464,
      memHourlyPerGb: Number(process.env.COST_MEM_PER_GB_HOUR) || 0.0058,
    };
    cache.set(cluster, fallback);
    return fallback;
  }
}
