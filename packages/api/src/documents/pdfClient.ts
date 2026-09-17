import type { ResolvedLayout } from './model';

export interface PdfServiceDeps {
  fetch: typeof fetch;
}

const defaultDeps: PdfServiceDeps = {
  fetch: globalThis.fetch.bind(globalThis),
};

function pdfServiceEndpoint(): string | null {
  const url = process.env.PDF_SERVICE_URL?.trim();
  if (!url) {
    return null;
  }
  const path = process.env.PDF_SERVICE_PATH?.trim();
  if (!path) {
    return url;
  }
  return new URL(path, url.endsWith('/') ? url : `${url}/`).toString();
}

function isPdfBuffer(data: Buffer): boolean {
  return data.subarray(0, 5).toString() === '%PDF-';
}

function decodeBase64Pdf(value: string): Buffer | null {
  try {
    const data = Buffer.from(value, 'base64');
    return isPdfBuffer(data) ? data : null;
  } catch {
    return null;
  }
}

function pdfFromJson(body: string): Buffer | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const candidates = [parsed.pdf, parsed.data, parsed.file, parsed.base64, parsed.content];
    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const pdf = decodeBase64Pdf(candidate);
        if (pdf) {
          return pdf;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function renderPdfViaService(
  html: string,
  layout: ResolvedLayout,
  deps: PdfServiceDeps = defaultDeps,
): Promise<Buffer | null> {
  const endpoint = pdfServiceEndpoint();
  if (!endpoint) {
    return null;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = process.env.PDF_SERVICE_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await deps.fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        html,
        paperSize: layout.pageSize.toLowerCase(),
        format: layout.pageSize,
        orientation: layout.orientation,
        landscape: layout.orientation === 'landscape',
      }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      throw new Error(`PDF-Dienst antwortete mit HTTP ${response.status}`);
    }
    if (isPdfBuffer(bytes)) {
      return bytes;
    }
    const fromJson = pdfFromJson(bytes.toString('utf8'));
    if (fromJson) {
      return fromJson;
    }
    throw new Error('PDF-Dienst lieferte keine PDF-Datei');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Zeitüberschreitung beim PDF-Dienst');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
