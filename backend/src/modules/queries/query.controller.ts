/**
 * Query HTTP handlers — PRD §4.4, §5.7, §10.3.
 *
 * Thin by design, exactly like document.controller.ts: parse nothing, decide
 * nothing, own no authorization. Every rule that matters lives in the service,
 * so there is one place to read when asking "who can see this query".
 *
 * The family gets a controller rather than inline handlers because it has five
 * endpoints — the same threshold documents crossed and dashboard/reports did not.
 */
import type { Request, Response, NextFunction } from 'express';
import { sendCreated, sendCursorPaginated, sendData } from '../../utils/envelope.js';
import { validatedQuery } from '../../middleware/validate.js';
import * as service from './query.service.js';
import type { CreateQueryInput, ListQueriesQuery, ReviewQueryInput } from './query.schema.js';

function actor(req: Request) {
  return { ipAddress: req.ip };
}

/** 201 with the row still in `queued` — D1: no answer is produced in the request. */
export async function ask(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendCreated(res, await service.askQuery(req.body as CreateQueryInput, req.user!, actor(req)));
  } catch (err) {
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Express 5 makes req.query a getter, so validated values come from res.locals.
    const result = await service.listQueries(validatedQuery<ListQueriesQuery>(res), req.user!);
    sendCursorPaginated(res, result.data, result.pagination);
  } catch (err) {
    next(err);
  }
}

/** The polling endpoint the client hits while status is queued/retrieving/answering. */
export async function getOne(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendData(res, await service.getQuery(req.params.id as string, req.user!));
  } catch (err) {
    next(err);
  }
}

export async function review(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendData(
      res,
      await service.reviewQuery(
        req.params.id as string,
        req.body as ReviewQueryInput,
        req.user!,
        actor(req),
      ),
    );
  } catch (err) {
    next(err);
  }
}

/** 200, not 201: an action-style POST that creates nothing (§10.3). */
export async function retry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendData(res, await service.retryQuery(req.params.id as string, req.user!, actor(req)));
  } catch (err) {
    next(err);
  }
}
