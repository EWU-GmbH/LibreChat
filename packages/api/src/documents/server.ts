import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDocx, createPdf, createXlsx, type SheetInput } from './builders';
import { resolveDocumentPath, storeDocument } from './storage';

const PORT = Number(process.env.PORT ?? 3000);
const STORAGE_DIRECTORY = process.env.DOCUMENT_STORAGE_PATH ?? '/data';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;
const AUTH_TOKEN = process.env.MCP_SERVER_AUTH_TOKEN ?? '';
const MAX_REQUEST_BYTES = 1024 * 1024;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const cellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const sheetSchema = z.object({
  name: z.string().min(1).max(31),
  rows: z.array(z.array(cellValueSchema).max(100)).min(1).max(5000),
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

async function readJsonBody(req: IncomingMessage): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error('Request body exceeds 1 MB');
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonValue;
}

function documentResult(filename: string, url: string, bytes: number) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Dokument erstellt: [${filename}](${url}) (${bytes} Bytes). Der Link ist 30 Tage gültig.`,
      },
    ],
  };
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'ewu-documents', version: '1.0.0' });

  server.tool(
    'create_docx',
    'Erstellt eine herunterladbare Word-Datei aus strukturiertem Markdown-Text.',
    {
      filename: z.string().min(1).max(120),
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(500_000),
    },
    async ({ filename, title, content }) => {
      const data = await createDocx(title, content);
      const stored = await storeDocument(
        STORAGE_DIRECTORY,
        PUBLIC_BASE_URL,
        ensureExtension(filename, '.docx'),
        data,
      );
      return documentResult(stored.filename, stored.url, data.length);
    },
  );

  server.tool(
    'create_xlsx',
    'Erstellt eine herunterladbare Excel-Arbeitsmappe mit bis zu 20 Tabellenblättern.',
    {
      filename: z.string().min(1).max(120),
      sheets: z.array(sheetSchema).min(1).max(20),
    },
    async ({ filename, sheets }) => {
      const data = await createXlsx(sheets as SheetInput[]);
      const stored = await storeDocument(
        STORAGE_DIRECTORY,
        PUBLIC_BASE_URL,
        ensureExtension(filename, '.xlsx'),
        data,
      );
      return documentResult(stored.filename, stored.url, data.length);
    },
  );

  server.tool(
    'create_pdf',
    'Erstellt eine herunterladbare PDF-Datei aus einem Titel und Fließtext.',
    {
      filename: z.string().min(1).max(120),
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(500_000),
    },
    async ({ filename, title, content }) => {
      const data = await createPdf(title, content);
      const stored = await storeDocument(
        STORAGE_DIRECTORY,
        PUBLIC_BASE_URL,
        ensureExtension(filename, '.pdf'),
        data,
      );
      return documentResult(stored.filename, stored.url, data.length);
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
