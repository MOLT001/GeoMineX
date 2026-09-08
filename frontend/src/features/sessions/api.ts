import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type { SessionSummary } from '@/auth/types';

/** Session management — PRD §5.11, §9.3. */

export function useSessions() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<SessionSummary[]>('/auth/sessions', { signal });
      return data;
    },
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      await api.delete(`/auth/sessions/${sessionId}`);
      return sessionId;
    },
    // §10.5: invalidate on every mutation.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  });
}
