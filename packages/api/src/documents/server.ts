import { z } from 'zod';
import { access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ContentBlock, DocumentInput, DocumentLayout, SheetInput } from './model';
import { createDocx, createPdf, createXlsx } from './builders';
import { resolveDocumentPath, storeDocument } from './storage';

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

const alignmentSchema = z.enum(['left', 'center', 'right', 'justify']);
const textStyleSchema = z.object({
  font: z.string().min(1).max(60).optional(),
  size: z.number().min(6).max(48).optional(),
  color: z.string().max(9).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
});

const layoutSchema = z.object({
  pageSize: z.enum(['A4', 'Letter']).optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
  marginsMm: z
    .object({
      top: z.number().min(0).max(80).optional(),
      right: z.number().min(0).max(80).optional(),
      bottom: z.number().min(0).max(80).optional(),
      left: z.number().min(0).max(80).optional(),
    })
    .optional(),
  header: z.string().max(200).optional(),
  footer: z.string().max(200).optional(),
  backgroundColor: z.string().max(9).optional(),
  defaultFont: z.string().min(1).max(60).optional(),
  defaultFontSize: z.number().min(6).max(36).optional(),
  defaultColor: z.string().max(9).optional(),
  accentColor: z.string().max(9).optional(),
  hideTitle: z.boolean().optional(),
});

const blockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: z.string().min(1).max(2000),
    align: alignmentSchema.optional(),
    style: textStyleSchema.optional(),
  }),
  z.object({
    type: z.literal('paragraph'),
    text: z.string().min(1).max(20_000),
    align: alignmentSchema.optional(),
    style: textStyleSchema.optional(),
  }),
  z.object({
    type: z.literal('list'),
    items: z.array(z.string().min(1).max(2000)).min(1).max(100),
    ordered: z.boolean().optional(),
    style: textStyleSchema.optional(),
  }),
  z.object({
    type: z.literal('table'),
    headers: z.array(z.string().max(500)).max(20).optional(),
    rows: z
      .array(z.array(z.string().max(2000)).min(1).max(20))
      .min(1)
      .max(100),
  }),
  z.object({
    type: z.literal('image'),
    src: z.string().min(1).max(2_000_000),
    alt: z.string().max(200).optional(),
    widthMm: z.number().min(10).max(190).optional(),
    align: alignmentSchema.optional(),
  }),
  z.object({
    type: z.literal('spacer'),
    heightMm: z.number().min(1).max(40).optional(),
  }),
  z.object({ type: z.literal('rule') }),
]);

const documentArgs = {
  filename: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  content: z.string().max(500_000).optional(),
  layout: layoutSchema.optional(),
  blocks: z.array(blockSchema).min(1).max(400).optional(),
};

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

async function storeGeneratedFile(filename: string, extension: string, data: Buffer) {
  return storeDocument(
    STORAGE_DIRECTORY,
    PUBLIC_BASE_URL,
    ensureExtension(filename, extension),
    data,
  );
}

const toolGuide =
  ' Übersetze Layout- und Designwünsche aus dem Chat in `layout` und `blocks` ' +
  '(Überschriften, Absätze, Listen, Tabellen, Linien, Abstände, Bilder). ' +
  'Bilder als öffentliche https-URL oder data-URI (PNG/JPEG, max. 2 MB, max. 12 Stück). ' +
  'Markdown in `content` bleibt möglich, inklusive ![alt](url).';

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'ewu-documents', version: '1.1.0' });

  server.tool(
    'create_docx',
    `Erstellt eine herunterladbare Word-Datei.${toolGuide}`,
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
      const data = await createDocx(input);
      const stored = await storeGeneratedFile(filename, '.docx', data);
      return documentResult(stored.filename, stored.url, data.length);
    },
  );

  server.tool(
    'create_xlsx',
    'Erstellt eine herunterladbare Excel-Arbeitsmappe mit bis zu 20 Tabellenblättern. Optional headerFill/headerColor für die Kopfzeile.',
    {
      filename: z.string().min(1).max(120),
      sheets: z.array(sheetSchema).min(1).max(20),
    },
    async ({ filename, sheets }) => {
      const data = await createXlsx(sheets as SheetInput[]);
      const stored = await storeGeneratedFile(filename, '.xlsx', data);
      return documentResult(stored.filename, stored.url, data.length);
    },
  );

  server.tool(
    'create_pdf',
    `Erstellt eine herunterladbare PDF-Datei.${toolGuide}`,
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
