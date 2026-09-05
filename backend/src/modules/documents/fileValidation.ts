/**
 * Server-side file validation — PRD §9.4, §5.4.
 *
 * The client also validates type and size, but that is a UX convenience; this
 * is the control. Three independent checks must agree:
 *
 *   1. extension allowlist
 *   2. declared MIME allowlist
 *   3. actual magic bytes
 *
 * (3) is what stops an executable renamed to `report.pdf`. A declared
 * Content-Type is attacker-controlled and worth nothing on its own.
 */
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { ApiError, ErrorCode } from '../../utils/apiError.js';
import type { DocumentType } from './document.model.js';

interface AcceptedType {
  extensions: string[];
  mimeTypes: string[];
  /** Magic-byte MIME reported by file-type; null = no reliable signature. */
  sniffed: string[] | null;
  documentType: DocumentType;
}

const ACCEPTED: AcceptedType[] = [
  { extensions: ['.pdf'], mimeTypes: ['application/pdf'], sniffed: ['application/pdf'], documentType: 'pdf' },
  {
    extensions: ['.png'],
    mimeTypes: ['image/png'],
    sniffed: ['image/png'],
    documentType: 'image',
  },
  {
    extensions: ['.jpg', '.jpeg'],
    mimeTypes: ['image/jpeg'],
    sniffed: ['image/jpeg'],
    documentType: 'image',
  },
  { extensions: ['.tif', '.tiff'], mimeTypes: ['image/tiff'], sniffed: ['image/tiff'], documentType: 'scan' },
  {
    extensions: ['.xlsx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    // xlsx is a zip container, so file-type reports the container format.
    sniffed: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
    documentType: 'spreadsheet',
  },
  // Plain text formats have no magic signature; the extension + MIME pair is
  // the check, and the content is inert (never executed — §9.4).
  { extensions: ['.csv'], mimeTypes: ['text/csv', 'application/csv'], sniffed: null, documentType: 'spreadsheet' },
  { extensions: ['.txt'], mimeTypes: ['text/plain'], sniffed: null, documentType: 'spreadsheet' },
];

export interface ValidatedFile {
  documentType: DocumentType;
  /** The MIME we trust — sniffed where available, else the validated declared one. */
  resolvedMimeType: string;
  extension: string;
}

export async function validateUpload(
  buffer: Buffer,
  originalFilename: string,
  declaredMimeType: string,
): Promise<ValidatedFile> {
  if (buffer.byteLength === 0) {
    throw new ApiError(ErrorCode.VALIDATION_ERROR, 'Uploaded file is empty');
  }

  const extension = path.extname(originalFilename).toLowerCase();
  const rule = ACCEPTED.find((a) => a.extensions.includes(extension));
  if (!rule) {
    const allowed = ACCEPTED.flatMap((a) => a.extensions).join(', ');
    throw new ApiError(ErrorCode.VALIDATION_ERROR, `Unsupported file extension. Accepted: ${allowed}`);
  }

  // Strip any charset parameter before comparing (e.g. "text/csv; charset=utf-8").
  const declared = declaredMimeType.split(';')[0]!.trim().toLowerCase();

  /*
   * "I don't know what this is" is a legitimate answer, not an attack.
   *
   * Postman's file picker, browsers and bare `curl` all send
   * application/octet-stream when the OS has no registered type for an
   * extension — which on Windows includes .csv. Rejecting that blocked honest
   * clients while stopping no attacker: the declared type is client-supplied,
   * so anyone malicious simply claims the matching one.
   *
   * The controls that actually hold are the extension allowlist above and the
   * content checks below, neither of which the client can talk its way past.
   */
  const declaredIsUnknown = declared === '' || declared === 'application/octet-stream';

  if (!declaredIsUnknown && !rule.mimeTypes.includes(declared)) {
    // A declared type that CONTRADICTS the extension is still refused — that
    // is a confused or dishonest client, not an uninformed one.
    throw new ApiError(
      ErrorCode.VALIDATION_ERROR,
      `Declared content type "${declared}" does not match the ${extension} extension`,
    );
  }

  if (rule.sniffed) {
    const sniff = await fileTypeFromBuffer(buffer);
    if (!sniff || !rule.sniffed.includes(sniff.mime)) {
      // The decisive check for binary formats: contents disagree with the
      // extension, e.g. an executable renamed to .pdf.
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'File contents do not match the declared file type',
      );
    }
    return { documentType: rule.documentType, resolvedMimeType: sniff.mime, extension };
  }

  /*
   * Text formats have no magic signature, so with an unknown declared type the
   * extension would otherwise be the only check. Confirm the bytes really are
   * text: a NUL byte or a high proportion of control characters means binary
   * content wearing a .csv extension.
   */
  if (!looksLikeText(buffer)) {
    throw new ApiError(
      ErrorCode.VALIDATION_ERROR,
      `File contents are not text, which a ${extension} file must be`,
    );
  }

  // Fall back to the rule's canonical type when the client did not know one,
  // so what we store is never the meaningless octet-stream.
  const resolvedMimeType = declaredIsUnknown ? rule.mimeTypes[0]! : declared;
  return { documentType: rule.documentType, resolvedMimeType, extension };
}

/**
 * Heuristic text check for formats with no magic bytes.
 *
 * A NUL byte is decisive — text files do not contain them. Beyond that, a
 * meaningful share of control characters indicates binary content. Only the
 * first 8 KB is inspected; that is ample to classify a file and keeps the
 * check cheap for a 25 MB upload.
 */
function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  let control = 0;

  for (const byte of sample) {
    if (byte === 0) return false;
    // Allow tab (9), LF (10), CR (13), FF (12); count other C0 controls.
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) control += 1;
  }
  return control / sample.length < 0.05;
}

export const ACCEPTED_EXTENSIONS = ACCEPTED.flatMap((a) => a.extensions);
