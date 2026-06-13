'use client';

import Image from 'next/image';
import { pavelt } from '@/lib/fonts';
import { cn } from '@/lib/utils';

type BrandLogoProps = {
  collapsed?: boolean;
  className?: string;
};

type BrandNameProps = {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
};

const BRAND_SIZE = {
  sm: 'text-sm',
  md: 'text-lg',
  lg: 'sidebar-brand-name',
} as const;

export function BrandName({ size = 'md', className }: BrandNameProps) {
  return (
    <p className={cn(pavelt.className, 'font-brand leading-none', BRAND_SIZE[size], className)}>
      <span className={size === 'lg' ? 'sidebar-brand-secure' : 'text-foreground'}>Secure</span>
      <span className={size === 'lg' ? 'sidebar-brand-accent' : 'brand-accent'}>Nexus</span>
    </p>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn('brand-mark group relative shrink-0', className)}>
      <span className="brand-mark-ring" aria-hidden />
      <span className="brand-mark-pulse" aria-hidden />
      <div className="brand-mark-inner relative z-10 flex h-full w-full items-center justify-center overflow-hidden rounded-[10px] bg-gradient-to-br from-blue-500/20 via-sky-500/10 to-blue-600/5 ring-1 ring-blue-500/25 shadow-sm shadow-blue-500/20">
        <Image
          src="/brand/shield-logo.png"
          alt=""
          width={100}
          height={100}
          className="brand-mark-img h-[78%] w-[78%] object-contain"
          priority
        />
      </div>
    </div>
  );
}

export function BrandLogo({ collapsed = false, className }: BrandLogoProps) {
  if (collapsed) {
    return (
      <div className={cn('flex w-full items-center justify-center', className)}>
        <span className={cn(pavelt.className, 'sidebar-brand-collapsed')}>
          <span className="sidebar-brand-secure">S</span>
          <span className="sidebar-brand-accent">N</span>
        </span>
      </div>
    );
  }

  return (
    <div className={cn('sidebar-brand-wrap flex min-w-0 items-center justify-center', className)}>
      <BrandName size="lg" className="inline-block text-center" />
    </div>
  );
}
