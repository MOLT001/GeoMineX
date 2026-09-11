/**
 * Archive reading — PS 26023 names "archives" as a required input.
 *
 * A subsidiary's quarterly submission arrives as one zip of scanned returns and
 * spreadsheets, and before this it could not be uploaded at all: `.zip` was not
 * on the extension allowlist, so the request was refused outright.
 *
 * ─── AN ARCHIVE IS ONE DOCUMENT, NOT MANY ───────────────────────────────────
 * A zip is unpacked and its members are read, but the result is ONE document
 * with one audit trail — the thing the user uploaded. Fanning a zip out into
 * separate `Document` rows would mean the upload endpoint creating records the
 * caller never asked for, each needing its own scope, review state and history,
 * and it would make an archive un-deletable as a unit. Members are recorded
 * instead in each figure's `sourceLocation.section`, which is what tells a
 * reader that a number came from `march/production.xlsx` inside the zip.
 *
 * ─── THIS IS THE HOSTILE-INPUT SURFACE ──────────────────────────────────────
 * Everything else in the ingestion path handles a single file whose size the
 * upload limit already bounds. An archive breaks that assumption: a few
 * kilobytes of zip can expand to gigabytes, and entry names are attacker-chosen
 * strings. Every limit below exists for a specific attack and none of them is
 * decoration — see each constant.
 */
import { unzipSync } from 'fflate';
import { logger } from '../../utils/logger.js';

/**
 * A ZIP BOMB is the reason this exists. `unzipSync` decompresses into memory,
 * and a classic 42 KB bomb expands to several petabytes; even a modest one can
 * exhaust the heap and take the whole API down with it. The cap is on the
 * DECOMPRESSED total, checked as members are taken, so the process stops
 * reading rather than stopping abruptly.
 */
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;

/** One member cannot itself be larger than the upload limit a direct file gets. */
const MAX_MEMBER_BYTES = 25 * 1024 * 1024;

/**
 * Enough for a quarterly submission, far short of the tens of thousands of
 * tiny entries a bomb uses to make extraction itself the denial of service.
 */
const MAX_MEMBERS = 50;

export interface ArchiveMember {
  /** The path as it appears inside the archive, normalised and vetted. */
  name: string;
  extension: string;
  buffer: Buffer;
}

export interface ArchiveContents {
  members: ArchiveMember[];
  skipped: string[];
}

/** Extensions worth extracting. A nested archive is deliberately absent. */
const READABLE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.xlsx', '.csv', '.txt']);

/**
 * Reject a member whose name tries to escape the archive.
 *
 * "Zip slip": an entry named `../../../etc/passwd` or `C:\Windows\...` walks out
 * of the extraction directory when written naively. Nothing here writes a
 * member to disk — they are read into memory and handed to a parser — so the
 * classic exploit does not apply. The check stays because the NAME is still
 * used, in the provenance shown to a user and stored on a figure, and an
 * absolute path or a traversal there is at best confusing and at worst a lure.
 */
function safeName(raw: string): string | null {
  const name = raw.replace(/\\/g, '/');
  if (!name || name.endsWith('/')) return null; // a directory entry
  if (name.startsWith('/') || /^[a-z]:/i.test(name)) return null; // absolute
  if (name.split('/').includes('..')) return null; // traversal
  // A leading dot-file inside a zip is almost always macOS metadata, not data.
  if (name.split('/').some((part) => part.startsWith('.') || part === '__MACOSX')) return null;
  return name;
}

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at < 0 ? '' : name.slice(at).toLowerCase();
}

/**
 * Unpack the members worth reading.
 *
 * Nested archives are NOT followed. A zip inside a zip is the cheapest way to
 * multiply a bomb past any single limit, and no real submission needs it — so
 * it is skipped and reported rather than silently ignored.
 */
export function readArchive(buffer: Buffer): ArchiveContents {
  const files = unzipSync(new Uint8Array(buffer)) as unknown as Record<string, Uint8Array>;

  const members: ArchiveMember[] = [];
  const skipped: string[] = [];
  let total = 0;

  // Sorted so a given archive always yields the same order — and therefore the
  // same figures in the same sequence — rather than depending on zip ordering.
  for (const rawName of Object.keys(files).sort()) {
    const data = files[rawName];
    if (!data) continue;

    const name = safeName(rawName);
    if (!name) continue; // directory, metadata, or an unsafe path: not worth reporting

    const extension = extensionOf(name);
    if (extension === '.zip') {
      skipped.push(`${name} (nested archives are not opened)`);
      continue;
    }
    if (!READABLE.has(extension)) {
      skipped.push(`${name} (unsupported type)`);
      continue;
    }
    if (data.byteLength > MAX_MEMBER_BYTES) {
      skipped.push(`${name} (larger than the ${MAX_MEMBER_BYTES / 1024 / 1024} MB member limit)`);
      continue;
    }
    if (members.length >= MAX_MEMBERS) {
      skipped.push(`${name} (beyond the ${MAX_MEMBERS}-file limit)`);
      continue;
    }
    if (total + data.byteLength > MAX_TOTAL_BYTES) {
      skipped.push(`${name} (archive exceeded the decompressed size limit)`);
      // Keep going: later members may be small enough to fit, and stopping here
      // would make inclusion depend on alphabetical luck alone.
      continue;
    }

    total += data.byteLength;
    members.push({ name, extension, buffer: Buffer.from(data) });
  }

  if (skipped.length > 0) {
    logger.info('archive: some members were not read', { count: skipped.length });
  }
  return { members, skipped };
}

/** MIME type to hand a member to the extractor, by extension. */
export function mimeForExtension(extension: string): string | null {
  switch (extension) {
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.csv':
      return 'text/csv';
    case '.txt':
      return 'text/plain';
    default:
      return null;
  }
}
