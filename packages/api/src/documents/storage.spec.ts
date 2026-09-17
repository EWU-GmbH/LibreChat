import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolveDocumentPath, storeDocument } from './storage';

describe('document storage', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'documents-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('stores a document behind an unguessable capability URL', async () => {
    const stored = await storeDocument(
      directory,
      'https://documents.example.com/',
      '../Monatsbericht 2026.docx',
      Buffer.from('content'),
    );
    const resolved = resolveDocumentPath(directory, stored.token, stored.filename);

    expect(stored.filename).toBe('Monatsbericht_2026.docx');
    expect(stored.url).toMatch(
      /^https:\/\/documents\.example\.com\/files\/[0-9a-f-]{36}\/Monatsbericht_2026\.docx$/,
    );
    expect(resolved).toBe(stored.path);
    await expect(readFile(stored.path, 'utf8')).resolves.toBe('content');
  });

  it('rejects malformed tokens and filenames', () => {
    expect(resolveDocumentPath(directory, 'not-a-token', 'report.pdf')).toBeNull();
    expect(
      resolveDocumentPath(directory, '00000000-0000-0000-0000-000000000000', '../report.pdf'),
    ).toBeNull();
  });
});
