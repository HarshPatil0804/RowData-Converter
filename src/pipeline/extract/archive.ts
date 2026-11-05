import JSZip from 'jszip';
import { LIMITS } from '../limits';

export interface ArchiveEntry {
  name: string;
  bytes: Uint8Array;
}

const mb = (bytes: number): string => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

/** Read every regular file from a ZIP archive (nested archives handled by the orchestrator). */
export async function extractArchive(bytes: Uint8Array): Promise<ArchiveEntry[]> {
  let zip: import('jszip');
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ZIP archive: ${message}`);
  }

  // Count declared entries before inflating anything: a 10,000-entry archive
  // is refused up front rather than after 10,000 reads.
  const declared = Object.values(zip.files).filter((file) => !file.dir);
  if (declared.length > LIMITS.archiveEntries) {
    throw new Error(
      `This archive holds ${declared.length.toLocaleString()} files, but the limit is ` +
        `${LIMITS.archiveEntries.toLocaleString()}. Split it into smaller archives and try again.`,
    );
  }

  const entries: ArchiveEntry[] = [];
  let total = 0;

  for (const file of declared) {
    const segments = file.name.split('/');
    const base = segments[segments.length - 1];
    if (segments.includes('__MACOSX') || base.startsWith('.')) continue;

    const data = await file.async('uint8array');
    total += data.byteLength;
    if (total > LIMITS.archiveUncompressedBytes) {
      throw new Error(
        `This archive expands to more than ${mb(LIMITS.archiveUncompressedBytes)} (limit reached at ` +
          `"${file.name}"). It was stopped early instead of being unpacked — split it and try again.`,
      );
    }
    // A small archive that inflates enormous is a zip bomb by shape alone.
    const ratio = bytes.byteLength > 0 ? total / bytes.byteLength : 0;
    if (ratio > LIMITS.archiveCompressionRatio) {
      throw new Error(
        `This archive expands ${Math.round(ratio)}× (the limit is ${LIMITS.archiveCompressionRatio}×), ` +
          'which is what a zip bomb looks like. It was not unpacked.',
      );
    }
    entries.push({ name: file.name, bytes: data });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}
