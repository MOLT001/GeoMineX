import type { Request, Response, NextFunction } from 'express';
import { sendCreated, sendCursorPaginated, sendData } from '../../utils/envelope.js';
import { validatedQuery } from '../../middleware/validate.js';
import { ApiError, ErrorCode } from '../../utils/apiError.js';
import * as service from './document.service.js';
import type { ListDocumentsQuery, OverrideFieldInput } from './document.schema.js';

function actor(req: Request) {
  return { ipAddress: req.ip };
}

export async function upload(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const file = req.file;
    if (!file) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'No file uploaded — send it as multipart field "file"');
    }

    const body = req.body as { subsidiaryId: string; tags: string[] };
    sendCreated(res, await service.uploadDocument(file, body, req.user!, actor(req)));
  } catch (err) {
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.listDocuments(validatedQuery<ListDocumentsQuery>(res), req.user!);
    sendCursorPaginated(res, result.data, {
      ...result.pagination,
      ...(result.topicsTruncated ? { topicsTruncated: true } : {}),
    });
  } catch (err) {
    next(err);
  }
}

export async function getOne(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendData(res, await service.getDocument(req.params.id as string, req.user!));
  } catch (err) {
    next(err);
  }
}

/**
 * Stream the original file — PRD §5.8, §9.4.
 *
 * Sent as an attachment with `nosniff`, so a browser never renders an
 * uploaded document inline in the API's origin.
 */
export async function download(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { stream, filename, mimeType, sizeBytes } = await service.streamDocumentFile(
      req.params.id as string,
      req.user!,
      actor(req),
    );

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(sizeBytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Quotes + encodeURIComponent keep a crafted filename from injecting
    // extra header directives.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );

    stream.on('error', (err: unknown) => {
      // Headers may already be sent, so delegate rather than trying to
      // rewrite the response.
      next(err);
    });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

export async function chunks(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendData(res, await service.getDocumentChunks(req.params.id as string, req.user!));
  } catch (err) {
    next(err);
  }
}

export async function extractedFields(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendData(res, await service.getExtractedFields(req.params.id as string, req.user!));
  } catch (err) {
    next(err);
  }
}

export async function retry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendData(res, await service.retryDocument(req.params.id as string, req.user!, actor(req)));
  } catch (err) {
    next(err);
  }
}

export async function overrideField(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendData(
      res,
      await service.overrideExtractedField(
        req.params.id as string,
        req.body as OverrideFieldInput,
        req.user!,
        actor(req),
      ),
    );
  } catch (err) {
    next(err);
  }
}

/**
 * §4.5 — figures on which two documents in one subsidiary disagree.
 *
 * Mounted above `/:id` so the literal path is not read as a document id.
 */
export async function conflicts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = validatedQuery<{ subsidiaryId?: string; status?: 'open' | 'acknowledged' | 'resolved'; limit: number }>(res);
    sendData(res, await service.listConflicts(q, req.user!));
  } catch (err) {
    next(err);
  }
}

/** §12/§19 — the document's own topics, keywords and summary. */
export async function topics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendData(res, await service.getDocumentTopics(req.params.id as string, req.user!));
  } catch (err) {
    next(err);
  }
}

/** §17 — documents sharing this one's subjects. */
export async function related(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { limit } = validatedQuery<{ limit: number }>(res);
    sendData(res, await service.listRelatedDocuments(req.params.id as string, req.user!, limit));
  } catch (err) {
    next(err);
  }
}

/** §19/§21 — re-run the analysis on request. Does not re-read the file. */
export async function reprocessTopics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendData(res, await service.reprocessTopics(req.params.id as string, req.user!, actor(req)));
  } catch (err) {
    next(err);
  }
}
