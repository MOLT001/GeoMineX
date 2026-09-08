'use client';

import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@/lib/queryClient';
import { AuthProvider } from '@/auth/AuthProvider';
import { ErrorBoundary } from '@/components/ErrorBoundary';

/**
 * Client providers, in the order they must nest.
 *
 * ErrorBoundary is outermost so it still renders if a provider below it throws.
 * AuthProvider sits inside QueryClientProvider because signing out has to purge
 * the query cache, so it needs `useQueryClient`.
 *
 * The QueryClient is created in `useState` rather than at module scope: a
 * module-level client would be shared across every request on the server and
 * could leak one user's cached data into another's response. Per-mount is the
 * documented pattern and the safe one.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
