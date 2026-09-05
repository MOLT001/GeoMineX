/**
 * Multipart upload handling — PRD §9.2, §9.4.
 *
 * Applied to the document-upload route ONLY. The global 10kb JSON limit in
 * app.ts stays untouched: raising that to fit a scanned PDF would remove the
 * body-size protection from every JSON endpoint in the system.
 *
 * multer version note: 2.3.0 or later is required. Versions below it carry
 * CVE-2026-2359 and CVE-2026-3304 (denial of service via unclosed streams and
 * incomplete cleanup), and `fieldArrayIndexLimit` — the mitigation added in
 * 2.3.0 — is opt-in, so it is set explicitly below rather than left default.
 */
import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { ApiError, ErrorCode } from '../utils/apiError.js';

/**
 * `fieldArrayIndexLimit` exists in the multer 2.3.0 runtime
 * (lib/make-middleware.js) and is documented in its README, but is missing
 * from @types/multer@2.2.0 — the types lag the release. Casting the limits
 * object keeps the CVE mitigation rather than dropping it to satisfy a stale
 * type definition. Remove the cast once the types catch up.
 */
const limits = {
  fileSize: env.MAX_UPLOAD_BYTES,
  files: 1,
  fields: 10,
  parts: 12,
  headerPairs: 100,
  fieldNameSize: 100,
  fieldSize: 8 * 1024,
  fieldArrayIndexLimit: 10,
} as unknown as multer.Options['limits'];

const upload = multer({
  // Memory storage keeps the bytes out of the filesystem until they have been
  // validated (magic bytes, size, type) and a server-controlled key exists.
  // Bounded by MAX_UPLOAD_BYTES below.
  storage: multer.memoryStorage(),
  limits,
});

const singleFile = upload.single('file');

/** Wraps multer so its errors surface in the standard envelope (§10.3). */
export function uploadSingleDocument(req: Request, res: Response, next: NextFunction): void {
  singleFile(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }

    if (err instanceof multer.MulterError) {
      const mapped =
        err.code === 'LIMIT_FILE_SIZE'
          ? new ApiError(
              ErrorCode.PAYLOAD_TOO_LARGE,
              `File exceeds the maximum upload size of ${Math.floor(env.MAX_UPLOAD_BYTES / 1_048_576)} MB`,
            )
          : new ApiError(ErrorCode.VALIDATION_ERROR, `Upload rejected: ${err.code}`);
      next(mapped);
      return;
    }
    next(err);
  });
}
