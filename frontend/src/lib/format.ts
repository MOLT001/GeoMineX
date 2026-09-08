/**
 * Number and size formatting shared across features.
 *
 * `formatBytes` lived twice — once on the document detail page, once in the
 * upload panel — and the two copies had already drifted into rounding the same
 * file to different figures. One implementation, so a size reads the same
 * wherever it appears.
 */

/**
 * Matches the server's own phrasing of the cap ("25 MB") rather than MiB.
 *
 * MB keeps one decimal only below 10, where the difference between 1.2 and 1 MB
 * is worth a character; above that the tenths are noise beside a 25 MB limit.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
