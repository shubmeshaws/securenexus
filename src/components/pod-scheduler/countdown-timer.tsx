'use client';

import { useEffect, useRef, useState } from 'react';
import { formatCountdown } from '@/lib/utils';
import { cn } from '@/lib/utils';

function getRemainingMs(targetIso: string): number {
  const targetMs = new Date(targetIso).getTime();
  if (Number.isNaN(targetMs)) return 0;
  return Math.max(0, targetMs - Date.now());
}

export function CountdownTimer({
  targetIso,
  className,
}: {
  targetIso: string;
  className?: string;
}) {
  const targetRef = useRef(targetIso);
  targetRef.current = targetIso;

  const [remainingMs, setRemainingMs] = useState(() => getRemainingMs(targetIso));

  useEffect(() => {
    setRemainingMs(getRemainingMs(targetIso));
    const id = window.setInterval(() => {
      setRemainingMs(getRemainingMs(targetRef.current));
    }, 1000);
    return () => window.clearInterval(id);
  }, [targetIso]);

  return (
    <span className={cn('font-mono text-xs tabular-nums text-emerald-600 dark:text-emerald-400', className)}>
      {formatCountdown(remainingMs)}
    </span>
  );
}
