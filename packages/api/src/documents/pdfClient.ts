import type { ResolvedLayout } from './model';

export interface PdfServiceDeps {
  fetch: typeof fetch;
}

const defaultDeps: PdfServiceDeps = {
  fetch: globalThis.fetch.bind(globalThis),
};

const DEFAULT_RENDER_PATH = '/generate-pdf';

function pdfServiceEndpoint(): string | null {
  const configured = process.env.PDF_SERVICE_URL?.trim();
  if (!configured) {
    return null;
  }
  const url = new URL(configured);
  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = DEFAULT_RENDER_PATH;
  }
  return url.toString();
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
      /** Header, footer and page numbers come from the `@page` margin boxes in the HTML;
       * sending templates as well makes Chromium print both. */
      body: JSON.stringify({
        mainContent: html,
        options: {
          format: layout.pageSize,
          landscape: layout.orientation === 'landscape',
          margins: {
            top: `${layout.marginsMm.top}mm`,
            right: `${layout.marginsMm.right}mm`,
            bottom: `${layout.marginsMm.bottom}mm`,
            left: `${layout.marginsMm.left}mm`,
          },
        },
      }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      throw new Error(`PDF-Dienst antwortete mit HTTP ${response.status}`);
    }
    if (bytes.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('PDF-Dienst lieferte keine PDF-Datei');
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Zeitüberschreitung beim PDF-Dienst');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
