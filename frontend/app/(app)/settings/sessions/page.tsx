'use client';

import { useState } from 'react';
import { useSessions, useRevokeSession } from '@/features/sessions/api';
import { useMe } from '@/features/users/api';
import { useAuth } from '@/auth/AuthProvider';
import { ROLE_LABELS } from '@/auth/permissions';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  EmptyState,
  ErrorState,
  InlineError,
  LoadingBlock,
  StatusMessage,
} from '@/components/ui/Feedback';
import { Card, DescriptionList, PageHeader, Section } from '@/components/ui/Layout';
import { userMessage } from '@/lib/api/errors';
import { formatDateTime, formatRelative } from '@/lib/datetime';

/**
 * Session management — PRD §5.11.
 *
 * Added in v1.3: §9.3 required users to view and revoke their own sessions and
 * §13 made it an acceptance criterion, but no screen in §5 ever owned it, so
 * the endpoints existed with nowhere to surface them.
 */
export default function SessionsPage() {
  const { user } = useAuth();
  /*
    The panel below is self-facing, so it reads GET /users/me and not
    `useAuth().user`: the latter is the JWT claim set, which only changes on
    sign-in or a token refresh (AuthProvider.tsx:47-51), so an admin who renames
    you — or changes your role — would leave this panel stating the old values
    for the rest of the access token's life. The claims stand in only for the
    first paint, before /users/me has answered.
  */
  const { data: me } = useMe();
  const profile = me ?? user;

  const { data, isPending, isError, error, refetch } = useSessions();
  const sessions = data ?? [];
  const revoke = useRevokeSession();

  /*
    Revoking removes the row that was pressed, so the outcome has to be
    announced somewhere that survives it. Holds the device label captured at
    press time, not `revoke.variables` — that is an opaque session id, and the
    row it named is gone by the time this renders.
  */
  const [revoked, setRevoked] = useState<string | null>(null);

  function revokeSession(sessionId: string, device: string) {
    setRevoked(null);
    revoke.mutate(sessionId, { onSuccess: () => setRevoked(device) });
  }

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <PageHeader
        title="Your account"
        description="Where you are signed in, and how to end a session you don't recognise."
      />

      {profile ? (
        <Card muted>
          <DescriptionList
            columns={3}
            items={[
              { label: 'Name', value: profile.name },
              { label: 'Email', value: profile.email },
              { label: 'Role', value: ROLE_LABELS[profile.role] },
            ]}
          />
        </Card>
      ) : null}

      <Section id="sessions" title="Active sessions">
        {revoked ? (
          <StatusMessage>Revoked {revoked}. That device is signed out.</StatusMessage>
        ) : null}

        {revoke.error ? <InlineError>{userMessage(revoke.error)}</InlineError> : null}

        {isPending ? <LoadingBlock label="Loading sessions" rows={3} /> : null}

        {isError ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

        {!isPending && !isError ? (
          sessions.length === 0 ? (
            <EmptyState
              title="No active sessions"
              // Not an ordinary empty list: this one always contains the tab you
              // are reading it in (auth.service.ts:289-297). Empty means the
              // session behind it is already gone.
              description="This list normally includes the device you are using. An empty one means this session has ended — reload to sign in again."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {sessions.map((session) => {
                const device = session.userAgent ?? 'Unknown device';
                return (
                  <li
                    key={session.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface p-4"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium text-text-default">
                        <span className="truncate">{device}</span>
                        {session.isCurrent ? <Badge tone="success">This device</Badge> : null}
                      </p>
                      <p className="mt-0.5 text-xs text-text-muted">
                        {session.ipAddress ?? 'IP unknown'} · active{' '}
                        {formatRelative(session.lastActiveAt)}
                        {' · '}
                        signed in {formatDateTime(session.createdAt)}
                      </p>
                    </div>

                    {/*
                      The current session is revocable through Sign out, which also
                      purges the query cache and tears the document down. Offering
                      Revoke here as well would leave the tab holding a dead token
                      with its cache intact.
                    */}
                    {session.isCurrent ? null : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => revokeSession(session.id, device)}
                        // `busy` is per row, `disabled` is every row: only the
                        // pressed control should read as working, but a second
                        // revoke must not start while the first is in flight.
                        busy={revoke.isPending && revoke.variables === session.id}
                        busyLabel="Revoking…"
                        disabled={revoke.isPending}
                      >
                        Revoke
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </Section>
    </div>
  );
}
