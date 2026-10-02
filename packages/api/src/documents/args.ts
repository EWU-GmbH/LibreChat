import { z } from 'zod';
import type { DocumentInput } from './model';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const permissiveJsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(permissiveJsonSchema),
    z.record(permissiveJsonSchema),
  ]),
);

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
  subtitle: z.string().max(300).optional(),
  theme: z.enum(['whitepaper', 'report', 'plain']).optional(),
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
    rows: z.array(z.array(z.string().max(2000)).min(1).max(20)).min(1).max(100),
  }),
  z.object({
    type: z.literal('image'),
    src: z.string().min(1).max(2_000_000),
    alt: z.string().max(200).optional(),
    caption: z.string().max(400).optional(),
    widthMm: z.number().min(10).max(190).optional(),
    align: alignmentSchema.optional(),
  }),
  z.object({
    type: z.literal('checklist'),
    items: z.array(z.string().min(1).max(2000)).min(1).max(100),
    checked: z.array(z.boolean()).max(100).optional(),
    style: textStyleSchema.optional(),
  }),
  z.object({
    type: z.literal('callout'),
    text: z.string().min(1).max(8000),
    title: z.string().max(200).optional(),
  }),
  z.object({ type: z.literal('pageBreak') }),
  z.object({
    type: z.literal('spacer'),
    heightMm: z.number().min(1).max(40).optional(),
  }),
  z.object({ type: z.literal('rule') }),
]);

const strictBlockArray = z.array(blockSchema).min(1).max(400);

export const documentArgs = {
  filename: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  content: z.string().max(500_000).optional(),
  layout: layoutSchema.optional(),
  blocks: strictBlockArray.optional(),
};

export const createDocxToolSchema = z.object({
  filename: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  content: z.union([z.string().max(500_000), permissiveJsonSchema]).optional(),
  layout: z
    .union([layoutSchema, permissiveJsonSchema])
    .optional()
    .describe('Objekt, kein JSON-String. Zum Beispiel { "theme": "whitepaper", "header": "EWU" }.'),
  blocks: z
    .union([strictBlockArray, permissiveJsonSchema])
    .optional()
    .describe(
      'Array von Block-Objekten, kein JSON-String. Jedes Objekt hat type: heading, paragraph, list, table, image, checklist, callout, pageBreak, spacer oder rule.',
    ),
});

const createDocxInputSchema = z.object({
  filename: documentArgs.filename,
  title: documentArgs.title,
  content: documentArgs.content,
  layout: documentArgs.layout,
  blocks: documentArgs.blocks,
});

export type CreateDocxToolArgs = z.infer<typeof createDocxToolSchema>;

const toolGuide =
  ' Übersetze Layout- und Designwünsche in `layout` (theme whitepaper, kurze header/footer, optional subtitle) ' +
  'und `blocks` (Überschriften, Absätze, Listen, Tabellen, checklist, callout, pageBreak, Bilder). ' +
  'Wenn der Nutzer Grafiken, Bilder oder Illustrationen im Dokument will: zuerst die Bild-Werkzeuge aufrufen, ' +
  'dann jedes Motiv mit `src: "lc-file:<file_id>"` an der passenden Stelle einfügen. ' +
  '`lc-file:latest` nur bei genau einem Bild; mehrere Bilder mit `lc-file:latest-1`, `latest-2` oder den file_ids. ' +
  'Bilder als öffentliche https-URL (PNG/JPEG/WebP/SVG) oder PNG/JPEG-data-URI (max. 2 MB, max. 12 Stück). ' +
  'Markdown in `content` bleibt möglich, inklusive ![alt](url) und - [ ] Checklisten.';

export const createDocxDescription =
  'Erstellt eine Word-Datei und liefert sie als Dateianhang. Gib keine Download-URL aus. ' +
  'layout ist ein Objekt und blocks ein Array von Block-Objekten. ' +
  'Beides als strukturierte Argumente übergeben, niemals als JSON-Text und niemals innerhalb von content. ' +
  'content ist optionaler Markdown-Text.' +
  toolGuide;

export const createPdfDescription = `Erstellt eine PDF-Datei und liefert sie als Dateianhang. Gib keine Download-URL aus.${toolGuide}`;

const exampleCall = {
  filename: 'bericht.docx',
  title: 'Bericht',
  layout: { theme: 'whitepaper' },
  blocks: [
    { type: 'heading', level: 1, text: 'Einleitung' },
    { type: 'paragraph', text: 'Kurztext.' },
  ],
};

const correctionFooter =
  'layout muss ein Objekt sein, blocks ein Array von Block-Objekten ' +
  '(type: heading, paragraph, list, table, image, checklist, callout, pageBreak, spacer oder rule). ' +
  'Übergib layout und blocks als strukturierte Felder, nicht als JSON-Text und nicht innerhalb von content. ' +
  'content ist optionaler Markdown-Text.\n' +
  'Minimales gültiges Beispiel:\n' +
  JSON.stringify(exampleCall, null, 2);

function correctionMessage(details: string): string {
  return (
    'create_docx: Argumente sind ungültig. Korrigiere den Aufruf und wiederhole ihn nicht unverändert.\n' +
    details +
    '\n' +
    correctionFooter
  );
}

function formatIssues(error: z.ZodError): string {
  const shown = error.issues.slice(0, 8);
  const lines = shown.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'argumente';
    return `- ${path}: ${issue.message}`;
  });
  if (error.issues.length > shown.length) {
    lines.push(`- ${error.issues.length - shown.length} weitere Abweichungen`);
  }
  return lines.join('\n');
}

function parseJsonValue(text: string): JsonValue | undefined {
  try {
    const parsed = permissiveJsonSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentEmbedsStructure(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false;
  }
  const parsed = parseJsonValue(trimmed);
  if (parsed === undefined) {
    return false;
  }
  if (Array.isArray(parsed)) {
    return parsed.some((item) => isRecord(item) && typeof item.type === 'string');
  }
  return isRecord(parsed) && ('blocks' in parsed || 'layout' in parsed);
}

function hasDocumentBody(
  content: string | undefined,
  blocks: readonly { type: string }[] | undefined,
): boolean {
  return Boolean((content && content.trim()) || (blocks && blocks.length > 0));
}

export type ResolvedCreateDocx =
  | { ok: true; filename: string; input: DocumentInput }
  | { ok: false; message: string };

export function resolveCreateDocxArgs(args: CreateDocxToolArgs): ResolvedCreateDocx {
  const parsed = createDocxInputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, message: correctionMessage(formatIssues(parsed.error)) };
  }

  if (parsed.data.content && contentEmbedsStructure(parsed.data.content)) {
    return {
      ok: false,
      message: correctionMessage(
        '- content: enthält JSON für layout oder blocks. Diese Felder gehören in die Argumente, nicht in den Markdown-Text.',
      ),
    };
  }

  if (!hasDocumentBody(parsed.data.content, parsed.data.blocks)) {
    return {
      ok: false,
      message: correctionMessage('- content: content oder blocks ist erforderlich.'),
    };
  }

  return {
    ok: true,
    filename: parsed.data.filename,
    input: {
      title: parsed.data.title,
      content: parsed.data.content,
      layout: parsed.data.layout,
      blocks: parsed.data.blocks,
    },
  };
}
