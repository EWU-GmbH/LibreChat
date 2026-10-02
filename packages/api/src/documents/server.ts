import { z } from 'zod';
import { access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ContentBlock, DocumentInput, DocumentLayout, SheetInput } from './model';
import {
  createDocxDescription,
  createDocxToolSchema,
  createPdfDescription,
  documentArgs,
  resolveCreateDocxArgs,
} from './args';
import { resolveDocumentPath, storeDocument } from './storage';
import { createDocx, createPdf, createXlsx } from './builders';
import { documentAttachment } from './result';
import { fetchUrl } from './fetch';

const PORT = Number(process.env.PORT ?? 3000);
const STORAGE_DIRECTORY = process.env.DOCUMENT_STORAGE_PATH ?? '/data';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;
const AUTH_TOKEN = process.env.MCP_SERVER_AUTH_TOKEN ?? '';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const cellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const sheetSchema = z.object({
  name: z.string().min(1).max(31),
  rows: z.array(z.array(cellValueSchema).max(100)).min(1).max(5000),
  headerFill: z.string().max(9).optional(),
  headerColor: z.string().max(9).optional(),
});

function ensureExtension(filename: string, extension: string): string {
  return filename.toLowerCase().endsWith(extension) ? filename : `${filename}${extension}`;
}

function authorized(req: IncomingMessage): boolean {
  if (!AUTH_TOKEN) {
    return false;
  }
  const actual = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${AUTH_TOKEN}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hasDocumentBody(content: string | undefined, blocks: ContentBlock[] | undefined): boolean {
  return Boolean((content && content.trim()) || (blocks && blocks.length > 0));
}

async function readJsonBody(req: IncomingMessage): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error('Request body exceeds 8 MB');
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonValue;
}

function fetchedPageResult(page: Awaited<ReturnType<typeof fetchUrl>>) {
  const images = page.images.length
    ? page.images.map((image) => `- ${image.alt ?? 'Bild'}: ${image.url}`).join('\n')
    : '- Keine gefunden';
  const colors = page.colors.length
    ? page.colors.map((color) => `- ${color}`).join('\n')
    : '- Keine';
  const truncation = page.truncated ? '\n\nHinweis: Der Inhalt wurde am Größenlimit gekürzt.' : '';
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Quelle: ${page.url}\n` +
          `Titel: ${page.title ?? 'Nicht angegeben'}\n\n` +
          `## Seiteninhalt\n\n${page.markdown}\n\n` +
          `## Bild-URLs\n\n${images}\n\n` +
          `## Erkannte Farben\n\n${colors}${truncation}`,
      },
    ],
  };
}

async function storeGeneratedFile(filename: string, extension: string, data: Buffer) {
  return storeDocument(
    STORAGE_DIRECTORY,
    PUBLIC_BASE_URL,
    ensureExtension(filename, extension),
    data,
  );
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'ewu-documents', version: '1.4.0' });

  server.tool(
    'fetch_url',
    'Lädt den Inhalt einer ausdrücklich genannten öffentlichen URL als bereinigtes Markdown und liefert Bild-URLs sowie erkannte Farben. Nutze dieses Werkzeug statt web_search, wenn der Nutzer Inhalte, Farben oder ein Logo von einer konkreten URL übernehmen möchte. Danach kann im selben Chat create_docx, create_pdf oder create_xlsx verwendet werden.',
    {
      url: z.string().url().max(2048),
    },
    async ({ url }) => fetchedPageResult(await fetchUrl(url)),
  );

  server.tool(
    'create_docx',
    createDocxDescription,
    createDocxToolSchema.shape,
    async (args) => {
      const resolved = resolveCreateDocxArgs(args);
      if (!resolved.ok) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: resolved.message }],
        };
      }
      const data = await createDocx(resolved.input);
      const stored = await storeGeneratedFile(resolved.filename, '.docx', data);
      return documentAttachment(stored.filename, data);
    },
  );

  server.tool(
    'create_xlsx',
    'Erstellt eine Excel-Arbeitsmappe mit bis zu 20 Tabellenblättern und liefert sie als Dateianhang. Gib keine Download-URL aus. Optional headerFill/headerColor für die Kopfzeile.',
    {
      filename: z.string().min(1).max(120),
      sheets: z.array(sheetSchema).min(1).max(20),
    },
    async ({ filename, sheets }) => {
      const data = await createXlsx(sheets as SheetInput[]);
      const stored = await storeGeneratedFile(filename, '.xlsx', data);
      return documentAttachment(stored.filename, data);
    },
  );

  server.tool(
    'create_pdf',
    createPdfDescription,
    documentArgs,
    async ({ filename, title, content, layout, blocks }) => {
      if (!hasDocumentBody(content, blocks as ContentBlock[] | undefined)) {
        throw new Error('content oder blocks ist erforderlich');
      }
      const input: DocumentInput = {
        title,
        content,
        layout: layout as DocumentLayout | undefined,
        blocks: blocks as ContentBlock[] | undefined,
      };
      const data = await createPdf(input);
      const stored = await storeGeneratedFile(filename, '.pdf', data);
      return documentAttachment(stored.filename, data);
    },
  );

  return server;
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleDownload(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', PUBLIC_BASE_URL);
  const match = /^\/files\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match || req.method !== 'GET') {
    return false;
  }

  const filename = decodeURIComponent(match[2]);
  const filepath = resolveDocumentPath(STORAGE_DIRECTORY, match[1], filename);
  if (!filepath) {
    sendJson(res, 404, { error: 'Document not found' });
    return true;
  }

  try {
    await access(filepath);
  } catch {
    sendJson(res, 404, { error: 'Document not found' });
    return true;
  }

  res.writeHead(200, {
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Type': 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(filepath).pipe(res);
  return true;
}

const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (await handleDownload(req, res)) {
    return;
  }
  if (req.url === '/mcp' && req.method === 'GET') {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }
  if (req.url !== '/mcp' || req.method !== 'POST') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request';
    sendJson(res, 400, { error: message });
  }
});

httpServer.listen(PORT, '0.0.0.0');
