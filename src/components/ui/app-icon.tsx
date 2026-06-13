import type { LucideIcon } from 'lucide-react';
import { ICON_STROKE } from '@/lib/icons';
import { cn } from '@/lib/utils';

const SIZES = {
  xs: 'h-3 w-3',
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
  xl: 'h-6 w-6',
} as const;

export function AppIcon({
  icon: Icon,
  size = 'md',
  className,
  strokeWidth = ICON_STROKE,
}: {
  icon: LucideIcon;
  size?: keyof typeof SIZES;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <Icon
      className={cn(SIZES[size], className)}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      absoluteStrokeWidth
    />
  );
}
