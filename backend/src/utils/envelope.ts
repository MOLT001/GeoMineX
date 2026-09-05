/** Standard response envelope — PRD §10.3. */
import type { Response } from 'express';

export interface Pagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CursorPagination {
  nextCursor: string | null;
  limit: number;
}

export function sendData<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

/** 201 for a POST that creates a resource — PRD §10.3. */
export function sendCreated<T>(res: Response, data: T): void {
  sendData(res, data, 201);
}

export function sendPaginated<T>(res: Response, data: T[], pagination: Pagination): void {
  res.status(200).json({ success: true, data, pagination });
}

/**
 * Cursor pagination for append-heavy lists — PRD §9.8. Audit logs and document
 * lists take continuous inserts, so offset paging would skip and duplicate
 * rows as the caller pages through them. `total` is omitted because it is not
 * meaningful for a set being written to concurrently.
 */
export function sendCursorPaginated<T>(res: Response, data: T[], pagination: CursorPagination): void {
  res.status(200).json({ success: true, data, pagination });
}
