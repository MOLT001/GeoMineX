import { Types } from 'mongoose';
import { AuditLog, type AuditAction } from './auditLog.model.js';
import { logger } from '../../utils/logger.js';

export interface AuditEntry {
  action: AuditAction;
  userId?: string;
  targetType?: string;
  targetId?: string;
  subsidiaryId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Write an audit record — PRD §9.6.
 *
 * Deliberately never throws: a failure to write the audit trail must not take
 * down the operation being audited, but it must be loud in the logs. Callers
 * may `await` it or not; it is safe either way.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await AuditLog.create({
      action: entry.action,
      userId: entry.userId ? new Types.ObjectId(entry.userId) : undefined,
      targetType: entry.targetType,
      targetId: entry.targetId ? new Types.ObjectId(entry.targetId) : undefined,
      subsidiaryId: entry.subsidiaryId ? new Types.ObjectId(entry.subsidiaryId) : undefined,
      metadata: entry.metadata,
      ipAddress: entry.ipAddress,
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error('Failed to write audit log', {
      action: entry.action,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
