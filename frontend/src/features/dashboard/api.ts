import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';

/**
 * Dashboard — PRD §5.3, §4.6.
 *
 * Server-state hooks live in the feature module; components never call the
 * client directly (§10.5).
 */

export interface QuickStats {
  extractionAccuracyPercent: number;
  timeSavedPercent: number;
  automationCoveragePercent: number;
  /**
   * When the aggregation was computed. §13 requires this to be VISIBLE: these
   * figures are cached, and a stale number presented as live is a traceability
   * defect in a product whose entire pitch is traceable figures.
   */
  computedAt: string;
  cached: boolean;
}

export interface DocumentCounts {
  total: number;
  validated: number;
  failed: number;
  awaitingReview: number;
}

export interface RecentReport {
  id: string;
  title: string;
  status: 'draft' | 'published' | 'archived';
  subsidiaryId: string;
  currentVersion: number;
  hasUnreviewedFigures: boolean;
  updatedAt: string;
}

/** Discriminated union — render each arm differently, do not flatten. */
export type PendingWork =
  | {
      kind: 'document';
      id: string;
      originalFilename: string;
      status: string;
      reason: string;
      subsidiaryId: string;
      createdAt: string;
    }
  | {
      kind: 'query';
      id: string;
      questionText: string;
      status: string;
      reason: string;
      subsidiaryId: string | null;
      createdAt: string;
    };

export interface DashboardData {
  quickStats: QuickStats;
  documents: DocumentCounts;
  recentReports: RecentReport[];
  pendingWork: PendingWork[];
}

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<DashboardData>('/dashboard', { signal });
      return data;
    },
    // The metrics are server-cached with a 5-minute TTL, so refetching faster
    // than that only costs requests and returns the same numbers.
    staleTime: 60_000,
  });
}
