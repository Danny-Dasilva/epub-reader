'use client';

import { useEffect } from 'react';
import { registerServiceWorker } from '@/lib/pwa';

export function ServiceWorkerProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    registerServiceWorker();
  }, []);

  return <>{children}</>;
}
