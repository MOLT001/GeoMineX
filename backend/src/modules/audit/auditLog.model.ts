import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Audit trail — PRD §9.6.
 *
 * Append-only by construction: there is no update or delete path through
 * ordinary CRUD (PRD §8.3). Records carry no passwords, tokens, API keys, or
 * unnecessary raw sensitive data.
 */
export const AUDIT_ACTIONS = [
  'auth.otp_requested',
  'auth.login_success',
  'auth.login_failed',
  'auth.account_locked',
  'auth.logout',
  'auth.token_refreshed',
  'auth.token_reuse_detected',
  'auth.session_revoked',
  'auth.sessions_revoked_all',
  'invite.issued',
  'invite.accepted',
  'user.created',
  'user.updated',
  'user.deactivated',
  'user.reactivated',
  'user.subsidiary_access_granted',
  'user.subsidiary_access_revoked',
  'subsidiary.created',
  'subsidiary.updated',
  'document.uploaded',
  'document.processed',
  'document.processing_failed',
  'document.retried',
  // A reviewer disagreeing with the analysis and asking for it again. Separate
  // from `document.retried`, which re-reads the FILE: the two have different
  // costs and different reasons, and an audit trail that merges them cannot
  // answer which one someone actually did.
  'document.topics_reprocessed',
  'document.downloaded',
  'extracted_field.overridden',
  'report_template.created',
  'report.created',
  'report.updated',
  'report.published',
  'report.archived',
  // ── AI queries (PRD §4.4, §5.7, §9.5) ──────────────────────────────────
  'query.asked',
  'query.answered',
  'query.generation_failed',
  'query.retried',
  'query.updated',
  'query.reviewed',
  'query.scope_revoked',
  /**
   * Separate ROWS rather than metadata on `query.answered`, so an operational
   * alert can key on the action alone. A spike in `query.citation_discarded` is
   * the system's primary fabricated-citation signal (§9.5).
   *
   * Nothing is recorded for cache invalidation: it is not a state change worth
   * a compliance record and it would drown the trail.
   */
  'query.injection_suspected',
  'query.citation_discarded',
  'document.injection_suspected',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditLogAttrs {
  /** Null for pre-authentication events such as a failed login. */
  userId?: Types.ObjectId;
  action: AuditAction;
  targetType?: string;
  targetId?: Types.ObjectId;
  subsidiaryId?: Types.ObjectId;
  /** Non-sensitive context only. */
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  timestamp: Date;
}

export type AuditLogDoc = HydratedDocument<AuditLogAttrs>;

const auditLogSchema = new Schema<AuditLogAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true, enum: AUDIT_ACTIONS },
    targetType: { type: String },
    targetId: { type: Schema.Types.ObjectId },
    subsidiaryId: { type: Schema.Types.ObjectId, ref: 'Subsidiary' },
    metadata: { type: Schema.Types.Mixed },
    ipAddress: { type: String },
    timestamp: { type: Date, required: true, default: () => new Date() },
  },
  { strict: true, strictQuery: true, versionKey: false },
);

// PRD §8.2 — audit query paths.
auditLogSchema.index({ subsidiaryId: 1, timestamp: -1 });
auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
// Supports the cursor pagination in PRD §9.8 (_id is monotonic per insert).
auditLogSchema.index({ timestamp: -1, _id: -1 });

export const AuditLog: Model<AuditLogAttrs> = mongoose.model<AuditLogAttrs>('AuditLog', auditLogSchema);
