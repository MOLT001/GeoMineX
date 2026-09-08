'use client';

import Link from 'next/link';
import type { AuthUser } from '@/auth/types';
import { SubsidiaryLabel } from '@/components/SubsidiaryPicker';
import { Badge } from '@/components/ui/Badge';
import { SourceLinkIcon } from '@/components/ui/Icon';
import { TD, TR } from '@/components/ui/Table';
import {
  auditRowMatchesSubsidiaryFilter,
  auditTargetHref,
  type AuditAction,
  type AuditLogEntry,
} from '@/features/audit/api';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/datetime';

/**
 * One row of the audit trail — PRD §5.10, §9.6.
 *
 * A dense table rather than a card list: an auditor reads down one column at a
 * time ("everything on Tuesday", "everything this account touched"), and a card
 * puts five of the six facts behind whichever one it leads with.
 */

/**
 * The column headers this row fills, so the header and the row cannot drift.
 *
 * There is no source-IP column and there cannot be one. `ipAddress` IS stored
 * (auditLog.model.ts:87, written by audit.service.ts:31) but is left out of the
 * list projection (audit.routes.ts:78-87), and `GET /audit-logs` is the only
 * endpoint this module has — so the column would be blank on every row, not on
 * some, which is worse than its absence.
 */
export const AUDIT_COLUMNS = ['When', 'Actor', 'Action', 'Target', 'Subsidiary', 'Details'] as const;

export function AuditEntryRow({
  entry,
  viewer,
  actorName,
  filteredSubsidiaryId,
}: {
  entry: AuditLogEntry;
  /** Drives the target link, which is role-gated for `User` and `Subsidiary` rows. */
  viewer: AuthUser | null;
  /** Resolved name for `entry.userId`, when the viewer has a directory to resolve it against. */
  actorName?: string | undefined;
  /** The subsidiary being filtered on, so rows that arrived past that filter can say so. */
  filteredSubsidiaryId?: string | undefined;
}) {
  const { domainLabel, verbLabel } = auditActionParts(entry.action);

  /*
    Rows may legitimately sit outside the subsidiary filter. For a non-admin the
    backend filter is `$or: [{ subsidiaryId }, { userId: you }]`
    (audit.routes.ts:58-61), so a filtered page still carries all of the viewer's
    own activity. Those rows are labelled, never dropped — dropping them would
    leave the visible count behind what the cursor already advanced past.
  */
  const offFilter = !auditRowMatchesSubsidiaryFilter(entry, filteredSubsidiaryId);

  return (
    <TR>
      <TD>
        <TimestampCell timestamp={entry.timestamp} />
      </TD>

      <TD>
        <ActorCell userId={entry.userId} actorName={actorName} viewer={viewer} />
      </TD>

      <TD className="whitespace-nowrap">
        {/* The raw enum value is what an auditor quotes, so it stays reachable. */}
        <span className="block" title={entry.action}>
          <span className="block text-xs tracking-wide text-text-muted uppercase">
            {domainLabel}
          </span>
          <span className="block font-medium text-text-default">{verbLabel}</span>
        </span>
      </TD>

      <TD>
        <TargetCell entry={entry} viewer={viewer} />
      </TD>

      <TD>
        <SubsidiaryLabel id={entry.subsidiaryId} />
        {offFilter ? (
          <span
            className="mt-1 block"
            title="Shown because it is your own activity, not because it matches the subsidiary filter."
          >
            <Badge tone="info" srPrefix="Scope">
              Your activity
            </Badge>
          </span>
        ) : null}
      </TD>

      <TD>
        <MetadataCell metadata={entry.metadata} />
      </TD>
    </TR>
  );
}

/**
 * Absolute IST first, relative second — §4.6.
 *
 * The absolute time leads because it is the value a compliance reader cites and
 * "3 hr ago" is unquotable. `formatRelative` falls back to the absolute string
 * once a row is over a day old, and an audit log is mostly rows older than that,
 * so the second line is dropped rather than printing the same string twice.
 */
function TimestampCell({ timestamp }: { timestamp: string }) {
  const absolute = formatDateTime(timestamp);
  const relative = formatRelative(timestamp);

  return (
    <time dateTime={timestamp} className="block">
      <span className="block whitespace-nowrap text-text-default tabular-nums">{absolute}</span>
      {relative === absolute ? null : (
        <span className="block text-xs text-text-muted">{relative}</span>
      )}
    </time>
  );
}

/**
 * Who did it.
 *
 * A null actor is a normal state, not a gap: the document worker writes
 * `document.processed`, `document.processing_failed` and
 * `document.injection_suspected` with no actor (document.worker.ts:190, :211,
 * :240), as does the seed script's `user.created`. The QUERY worker does pass
 * one on all five of its calls, so this must not be keyed on "worker ⇒ null".
 *
 * An id that cannot be named is shown as itself. There is no public user-lookup
 * route — GET /users is admin-only — and a placeholder label would hide the one
 * identifier that is actually traceable.
 */
function ActorCell({
  userId,
  actorName,
  viewer,
}: {
  userId: string | null;
  actorName: string | undefined;
  viewer: AuthUser | null;
}) {
  if (userId === null) {
    return (
      <span className="text-text-muted">
        System
        <span className="sr-only"> (no signed-in actor)</span>
      </span>
    );
  }

  const selfName = viewer !== null && userId === viewer.id ? viewer.name : undefined;
  const name = actorName ?? selfName;

  return (
    <>
      {name ? (
        <span className="block font-medium text-text-default">
          {name}
          {selfName ? <span className="font-normal text-text-muted"> (you)</span> : null}
        </span>
      ) : null}
      <span
        className={cn(
          'block font-mono text-xs break-all',
          name ? 'text-text-muted' : 'text-text-default',
        )}
      >
        {userId}
      </span>
    </>
  );
}

/**
 * What was acted on, deep-linked where a screen exists — §5.10 traceability.
 *
 * `auditTargetHref` returns null for the three target types with no route
 * (Session, ExtractedField, ReportTemplate) and for User/Subsidiary when the
 * viewer cannot reach the Admin Panel. Null renders as plain text: a link that
 * goes nowhere is worse than no link.
 *
 * A returned href can still land on a 404 — a row seen through the own-activity
 * clause may point into a subsidiary the viewer does not hold — and the
 * destination screen reports that as "not found", the same answer the API gives
 * and the only one that does not reveal whether the record exists.
 */
function TargetCell({ entry, viewer }: { entry: AuditLogEntry; viewer: AuthUser | null }) {
  if (!entry.targetType) return <span className="text-text-muted">—</span>;

  const href = auditTargetHref(entry, viewer);

  return (
    <>
      {href ? (
        <Link
          href={href}
          className="inline-flex items-center gap-1.5 font-medium text-sih-blue hover:underline"
        >
          <SourceLinkIcon size={14} />
          {entry.targetType}
        </Link>
      ) : (
        <span className="font-medium text-text-default">{entry.targetType}</span>
      )}
      {entry.targetId ? (
        <span className="block font-mono text-xs break-all text-text-muted">{entry.targetId}</span>
      ) : null}
    </>
  );
}

/**
 * The action's own metadata.
 *
 * Safe to render verbatim: §9.6 restricts it to counts and ids — never question
 * text, field values or excerpts (query.service.ts:350-352,
 * document.worker.ts:202-203) — and it reaches the DOM as a React text node
 * either way. Fifteen of the forty actions write none at all and always
 * serialise null, so the dash is the common case rather than a failure.
 *
 * Laid out inline rather than through `DescriptionList`, whose two-column grid
 * is sized for a detail panel and would make every row eight lines tall.
 */
function MetadataCell({ metadata }: { metadata: Record<string, unknown> | null }) {
  const pairs = readableMetadata(metadata);
  if (pairs.length === 0) return <span className="text-text-muted">—</span>;

  return (
    <dl className="flex max-w-xs flex-wrap gap-x-3 gap-y-0.5 text-xs">
      {pairs.map((pair) => (
        <div key={pair.key} className="min-w-0">
          <dt className="inline text-text-muted">{pair.label} </dt>
          <dd className="inline break-words text-text-default">{pair.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** `extracted_field.overridden` carries a typed-in `reason`; nothing else runs long. */
const MAX_METADATA_CHARS = 120;

interface MetadataPair {
  key: string;
  label: string;
  value: string;
}

function readableMetadata(metadata: Record<string, unknown> | null): MetadataPair[] {
  if (!metadata) return [];

  const pairs: MetadataPair[] = [];
  for (const [key, raw] of Object.entries(metadata)) {
    const value = formatMetadataValue(raw);
    if (value !== null) pairs.push({ key, label: humaniseKey(key), value });
  }
  return pairs;
}

/**
 * `metadata` is `Schema.Types.Mixed` and passes through no schema, so every
 * value is narrowed by `typeof` rather than cast to the shape
 * `AuditMetadataByAction` documents. Returns null for a value with no honest
 * one-line rendering — a nested object is dropped rather than printed as
 * "[object Object]".
 */
function formatMetadataValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) return '—';
  if (typeof raw === 'string') return truncate(raw);
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw.toLocaleString('en-IN') : String(raw);
  }
  if (typeof raw === 'boolean') return raw ? 'yes' : 'no';

  if (Array.isArray(raw)) {
    if (raw.length === 0) return 'none';
    const items = raw.filter(
      (item): item is string | number => typeof item === 'string' || typeof item === 'number',
    );
    return items.length === 0 ? null : truncate(items.join(', '));
  }

  return null;
}

function truncate(value: string): string {
  return value.length > MAX_METADATA_CHARS ? `${value.slice(0, MAX_METADATA_CHARS)}…` : value;
}

/**
 * An action split into its domain and its verb, both typeset.
 *
 * Derived from the enum value rather than read out of a hand-written table of
 * forty labels. That table would be a second copy of `AUDIT_ACTIONS`
 * (auditLog.model.ts:10-60) to keep in step, and a row carrying an action it had
 * not caught up with would render blank — on the one screen whose job is to
 * show what happened.
 *
 * It lives beside the row that renders it so the filter picker and the table
 * cannot label the same action two different ways.
 */
export function auditActionParts(action: AuditAction): {
  domain: string;
  domainLabel: string;
  verbLabel: string;
} {
  const dot = action.indexOf('.');
  if (dot < 0) return { domain: action, domainLabel: '', verbLabel: humanise(action) };

  const domain = action.slice(0, dot);
  return {
    domain,
    domainLabel: humanise(domain),
    verbLabel: humanise(action.slice(dot + 1)),
  };
}

function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  const cased = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  // "Otp requested" reads as a typo; it is the only initialism in the enum.
  return cased.replace(/\botp\b/gi, 'OTP');
}

/**
 * Metadata keys are camelCase where action names are snake_case
 * (`passagesWithheld`, `hasUnreviewedFigures`), so they need the other split.
 */
function humaniseKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}
