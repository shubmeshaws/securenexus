'use client';

import { SunMedium, MoonStar } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { useTheme } from '@/components/providers/theme-provider';
import { Switch } from '@/components/ui/switch';

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme, mounted } = useTheme();

  if (!mounted) {
    return <div className={cn('h-7 w-12 rounded-full bg-muted/50', className)} />;
  }

  const isDark = theme === 'dark';

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <SunMedium
        className={cn(
          'h-3.5 w-3.5 transition-colors',
          isDark ? 'text-muted-foreground/50' : 'text-amber-500'
        )}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Switch
        checked={isDark}
        onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      />
      <MoonStar
        className={cn(
          'h-3.5 w-3.5 transition-colors',
          isDark ? 'text-violet-400' : 'text-muted-foreground/50'
        )}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </div>
  );
}
