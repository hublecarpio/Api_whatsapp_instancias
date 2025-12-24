'use client';

import { ReactNode } from 'react';
import { GlassProvider } from './GlassProvider';

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <GlassProvider>
      {children}
    </GlassProvider>
  );
}
