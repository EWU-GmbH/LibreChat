import { validate } from '@cfworker/json-schema';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Schema } from '@cfworker/json-schema';
import type { z } from 'zod';
import type { CreateDocxToolArgs } from './args';
import { createDocxDescription, createDocxToolSchema, resolveCreateDocxArgs } from './args';

function advertisedSchema(schema: ReturnType<typeof zodToJsonSchema>): Schema {
  return JSON.parse(JSON.stringify(schema)) as Schema;
}

function acceptToolArgs(value: z.input<typeof createDocxToolSchema>): CreateDocxToolArgs {
  return createDocxToolSchema.parse(value);
}

const validArgs = {
  filename: 'bericht.docx',
  title: 'Bericht',
  layout: { theme: 'whitepaper' as const },
  blocks: [
    { type: 'heading' as const, level: 1 as const, text: 'Einleitung' },
    { type: 'paragraph' as const, text: 'Kurztext.' },
  ],
};

describe('create_docx arguments', () => {
  it('states the expected object shape when layout and blocks are JSON text', () => {
    const resolved = resolveCreateDocxArgs(
      acceptToolArgs({
        filename: 'bericht.docx',
        title: 'Bericht',
        layout: '{"theme":"whitepaper"}',
        blocks: '[{"type":"paragraph","text":"Hallo"}]',
      }),
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.message).toContain('layout');
    expect(resolved.message).toContain('Objekt');
    expect(resolved.message).toContain('blocks');
    expect(resolved.message).toContain('nicht als JSON-Text');
    expect(resolved.message).toContain('nicht innerhalb von content');
    expect(resolved.message).toContain('"type": "heading"');
    expect(resolved.message).toContain('bericht.docx');
  });

  it('rejects structured JSON stuffed into content', () => {
    const resolved = resolveCreateDocxArgs(
      acceptToolArgs({
        filename: 'bericht.docx',
        title: 'Bericht',
        content: JSON.stringify({
          layout: { theme: 'plain' },
          blocks: [{ type: 'paragraph', text: 'Hallo' }],
        }),
      }),
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.message).toContain('content');
    expect(resolved.message).toContain('layout');
    expect(resolved.message).toContain('blocks');
    expect(resolved.message).toContain('Minimales gültiges Beispiel');
  });

  it('names the invalid block field', () => {
    const resolved = resolveCreateDocxArgs(
      acceptToolArgs({
        filename: 'bericht.docx',
        title: 'Bericht',
        blocks: [{ type: 'paragraph' }],
      }),
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.message).toContain('blocks');
    expect(resolved.message).toContain('text');
  });

  it('accepts a structured call', () => {
    const resolved = resolveCreateDocxArgs(acceptToolArgs(validArgs));

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.filename).toBe('bericht.docx');
    expect(resolved.input.blocks).toHaveLength(2);
  });

  it('keeps malformed layout and blocks inside the advertised schema', () => {
    const schema = zodToJsonSchema(createDocxToolSchema, { strictUnions: true });
    const malformed = {
      filename: 'bericht.docx',
      title: 'Bericht',
      layout: '{"theme":"whitepaper"}',
      blocks: [{ type: 'paragraph' }],
    };

    const advertised = advertisedSchema(schema);
    expect(createDocxToolSchema.safeParse(malformed).success).toBe(true);
    expect(validate(malformed, advertised).valid).toBe(true);
    expect(validate(validArgs, advertised).valid).toBe(true);
  });

  it('describes layout and blocks as structured arguments', () => {
    expect(createDocxDescription).toContain('layout ist ein Objekt');
    expect(createDocxDescription).toContain('blocks ein Array');
    expect(createDocxDescription).toContain('niemals als JSON-Text');
    expect(createDocxDescription).toContain('niemals innerhalb von content');
  });
});
