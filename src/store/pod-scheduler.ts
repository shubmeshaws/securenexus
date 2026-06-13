'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface PodSchedulerStore {
  selectedCluster: string | null;
  selectedNamespace: string | null;
  selectedDeployment: string | null;
  savedReplicas: Record<string, number>;
  setSelectedCluster: (cluster: string | null) => void;
  setSelectedNamespace: (ns: string | null) => void;
  setSelectedDeployment: (name: string | null) => void;
  selectNamespace: (cluster: string, ns: string) => void;
  selectDeployment: (cluster: string, ns: string, name: string) => void;
  setSavedReplicas: (key: string, replicas: number) => void;
  getSavedReplicas: (key: string, fallback?: number) => number;
}

export const usePodSchedulerStore = create<PodSchedulerStore>()(
  persist(
    (set, get) => ({
      selectedCluster: null,
      selectedNamespace: null,
      selectedDeployment: null,
      savedReplicas: {},
      setSelectedCluster: (cluster) =>
        set({ selectedCluster: cluster, selectedNamespace: null, selectedDeployment: null }),
      setSelectedNamespace: (ns) => set({ selectedNamespace: ns, selectedDeployment: null }),
      setSelectedDeployment: (name) => set({ selectedDeployment: name }),
      selectNamespace: (cluster, ns) =>
        set({ selectedCluster: cluster, selectedNamespace: ns, selectedDeployment: null }),
      selectDeployment: (cluster, ns, name) =>
        set({ selectedCluster: cluster, selectedNamespace: ns, selectedDeployment: name }),
      setSavedReplicas: (key, replicas) =>
        set((s) => ({ savedReplicas: { ...s.savedReplicas, [key]: replicas } })),
      getSavedReplicas: (key, fallback = 1) => get().savedReplicas[key] ?? fallback,
    }),
    { name: 'pod-scheduler-store', partialize: (state) => ({ savedReplicas: state.savedReplicas }) }
  )
);

export function deploymentKey(cluster: string, ns: string, name: string) {
  return `${cluster}/${ns}/${name}`;
}
