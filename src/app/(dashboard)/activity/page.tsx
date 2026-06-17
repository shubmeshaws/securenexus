import { Suspense } from 'react';
import { Loader2 } from '@/lib/icons';
import { ActivityLogsContent } from '@/components/pod-scheduler/activity-logs-content';

export default function ActivityPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-20">
          <Loader2 className="h-7 w-7 animate-spin text-blue-500/50" />
        </div>
      }
    >
      <ActivityLogsContent />
    </Suspense>
  );
}
