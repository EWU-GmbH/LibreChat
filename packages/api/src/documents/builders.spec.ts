import JSZip from 'jszip';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { assertPublicHttpUrl, isBlockedIp, loadImageSource, parseDataUri } from './images';
import { createDocx, createPdf, createXlsx } from './builders';
import { parseMarkdownBlocks } from './model';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URI = `data:image/png;base64,${PNG_1X1}`;

describe('document builders', () => {
  it('creates a readable DOCX with title and body', async () => {
    const buffer = await createDocx({
      title: 'Projektstatus',
      content: '## Zusammenfassung\n- Alles funktioniert',
    });
    const extracted = await mammoth.extractRawText({ buffer });

    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(extracted.value).toContain('Projektstatus');
    expect(extracted.value).toContain('Alles funktioniert');
  });

  it('applies layout, tables, and data-URI images in DOCX', async () => {
    const buffer = await createDocx({
      title: 'Angebot',
      layout: {
        header: 'EWU GmbH',
        footer: 'vertraulich',
        accentColor: '#1f4e79',
        defaultFont: 'Calibri',
      },
      blocks: [
        { type: 'heading', level: 1, text: 'Leistungen', align: 'center' },
        {
          type: 'paragraph',
          text: 'Blaues Layout mit Tabelle und Logo.',
          style: { italic: true },
        },
        {
          type: 'table',
          headers: ['Position', 'Preis'],
          rows: [['Beratung', '1.200 €']],
        },
        {
          type: 'image',
          src: PNG_DATA_URI,
          alt: 'Logo',
          widthMm: 40,
          align: 'center',
        },
      ],
    });
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    const headerXml = await zip.file('word/header1.xml')?.async('string');
    const media = Object.keys(zip.files).filter((name) => name.startsWith('word/media/'));
    const html = await mammoth.convertToHtml({ buffer });

    expect(documentXml).toContain('1F4E79');
    expect(documentXml).toContain('Beratung');
    expect(headerXml).toContain('EWU GmbH');
    expect(media.length).toBeGreaterThan(0);
    expect(html.value).toMatch(/<img/i);
  });

  it('creates an XLSX with typed cells and header fill', async () => {
    const buffer = await createXlsx([
      {
        name: 'Umsatz',
        headerFill: '#1f4e79',
        rows: [
          ['Monat', 'Wert', 'Freigegeben'],
          ['September', 42, true],
        ],
      },
    ]);
    const workbook = new ExcelJS.Workbook();
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    await workbook.xlsx.load(arrayBuffer);
    const sheet = workbook.getWorksheet('Umsatz');

    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(sheet?.getCell('A2').value).toBe('September');
    expect(sheet?.getCell('B2').value).toBe(42);
    expect(sheet?.getCell('C2').value).toBe(true);
    expect(sheet?.getCell('A1').fill).toMatchObject({
      fgColor: { argb: 'FF1F4E79' },
    });
  });

  it('creates a PDF with an embedded image', async () => {
    const buffer = await createPdf({
      title: 'Prüfbericht',
      layout: { header: 'EWU', accentColor: '#cc0000' },
      content: `Das ist ein Test.\n![logo](${PNG_DATA_URI})`,
    });

    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.includes(Buffer.from('/Image'))).toBe(true);
    expect(buffer.length).toBeGreaterThan(500);
  });
});

describe('markdown and image safety', () => {
  it('parses headings, tables, lists, and images', () => {
    const blocks = parseMarkdownBlocks(
      [
        '# Titel',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '- eins',
        '- zwei',
        '',
        '![logo](https://example.com/logo.png)',
      ].join('\n'),
    );

    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: 'Titel' },
      { type: 'table', headers: ['A', 'B'], rows: [['1', '2']] },
      { type: 'list', ordered: false, items: ['eins', 'zwei'] },
      { type: 'image', alt: 'logo', src: 'https://example.com/logo.png' },
    ]);
  });

  it('loads PNG data URIs and rejects private image hosts', async () => {
    const image = await loadImageSource(PNG_DATA_URI, 40, 'Logo', 'center');
    expect(image.format).toBe('png');
    expect(image.widthMm).toBe(40);
    expect(parseDataUri(PNG_DATA_URI).length).toBeGreaterThan(10);

    expect(() => assertPublicHttpUrl('http://127.0.0.1/secret.png')).toThrow('nicht erlaubt');
    expect(() => assertPublicHttpUrl('https://localhost/logo.png')).toThrow('nicht erlaubt');
    expect(isBlockedIp('10.0.0.4')).toBe(true);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
  });

  it('rejects HTTP images that resolve to private addresses', async () => {
    await expect(
      loadImageSource('https://evil.example/logo.png', 40, 'x', 'left', {
        fetch: jest.fn(),
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).rejects.toThrow('nicht erlaubt');
  });

  it('converts public SVG logos to PNG for documents', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#123456"/></svg>',
    );
    const image = await loadImageSource('https://example.com/logo.svg', 40, 'Logo', 'left', {
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          arrayBuffer: async () => svg,
        }) as Pick<Response, 'arrayBuffer' | 'ok' | 'status'>,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    expect(image.format).toBe('png');
    expect(image.data.subarray(1, 4).toString('ascii')).toBe('PNG');
  });
});
