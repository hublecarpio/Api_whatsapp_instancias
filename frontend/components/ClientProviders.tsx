'use client';

import { ReactNode } from 'react';
import { GlassProvider } from './GlassProvider';
import { UiCapabilityProvider } from './UiCapabilityProvider';

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <GlassProvider>
      <UiCapabilityProvider>
        {children}
      </UiCapabilityProvider>
    </GlassProvider>
  );
}
