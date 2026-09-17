import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_FILENAME = /[^a-zA-Z0-9._-]+/g;

export interface StoredDocument {
  filename: string;
  path: string;
  token: string;
  url: string;
}

function sanitizeFilename(filename: string): string {
  const basename = path.basename(filename).replace(SAFE_FILENAME, '_').slice(0, 120);
  return basename || 'document';
}

async function removeExpiredFiles(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const cutoff = Date.now() - MAX_AGE_MS;

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filepath = path.join(directory, entry.name);
        const metadata = await stat(filepath);
        if (metadata.mtimeMs < cutoff) {
          await unlink(filepath);
        }
      }),
  );
}

export async function storeDocument(
  directory: string,
  publicBaseUrl: string,
  filename: string,
  data: Buffer,
): Promise<StoredDocument> {
  await mkdir(directory, { recursive: true });
  await removeExpiredFiles(directory);

  const safeFilename = sanitizeFilename(filename);
  const token = randomUUID();
  const filepath = path.join(directory, `${token}__${safeFilename}`);
  await writeFile(filepath, data, { flag: 'wx', mode: 0o600 });

  return {
    filename: safeFilename,
    path: filepath,
    token,
    url: `${publicBaseUrl.replace(/\/+$/, '')}/files/${token}/${encodeURIComponent(safeFilename)}`,
  };
}

export function resolveDocumentPath(
  directory: string,
  token: string,
  filename: string,
): string | null {
  if (!/^[0-9a-f-]{36}$/.test(token)) {
    return null;
  }
  const safeFilename = sanitizeFilename(filename);
  if (safeFilename !== filename) {
    return null;
  }
  return path.join(directory, `${token}__${safeFilename}`);
}
