import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  convertMillimetersToTwip,
} from 'docx';
import { load } from 'cheerio';
import { hexForDocx } from './model';

type CheerioAPI = ReturnType<typeof load>;
type CheerioEl = ReturnType<CheerioAPI>;

function runsFrom(
  $: CheerioAPI,
  selection: CheerioEl,
  extra?: { bold?: boolean; italics?: boolean },
): TextRun[] {
  const runs: TextRun[] = [];
  selection.contents().each((_, node) => {
    if (node.type === 'text') {
      const text = node.data ?? '';
      if (text) {
        runs.push(new TextRun({ text, bold: extra?.bold, italics: extra?.italics }));
      }
      return;
    }
    if (node.type !== 'tag') {
      return;
    }
    const name = node.name;
    if (name === 'span' && $(node).hasClass('box')) {
      return;
    }
    runs.push(
      ...runsFrom($, $(node), {
        bold: extra?.bold || name === 'strong' || name === 'b',
        italics: extra?.italics || name === 'em' || name === 'i',
      }),
    );
  });
  return runs;
}

type Alignment = (typeof AlignmentType)[keyof typeof AlignmentType];

function alignmentFrom(selection: CheerioEl): Alignment {
  if (selection.hasClass('align-center')) {
    return AlignmentType.CENTER;
  }
  if (selection.hasClass('align-right')) {
    return AlignmentType.RIGHT;
  }
  if (selection.hasClass('align-justify')) {
    return AlignmentType.JUSTIFIED;
  }
  return AlignmentType.LEFT;
}

function parseDataUri(src: string): { data: Buffer; format: 'png' | 'jpg' } | null {
  const match = /^data:image\/(png|jpe?g);base64,([a-zA-Z0-9+/=\s]+)$/i.exec(src.trim());
  if (!match) {
    return null;
  }
  return {
    format: match[1].toLowerCase().includes('png') ? 'png' : 'jpg',
    data: Buffer.from(match[2].replace(/\s+/g, ''), 'base64'),
  };
}

function widthMmFromStyle(style: string | undefined): number {
  const match = /width:\s*([0-9.]+)mm/i.exec(style ?? '');
  if (!match) {
    return 120;
  }
  return Math.min(Math.max(Number(match[1]), 10), 190);
}

export async function htmlToDocx(html: string): Promise<Buffer> {
  const $ = load(html);
  const root = $('html');
  const accent = root.attr('data-accent') || '#1f4e79';
  const color = root.attr('data-color') || '#111111';
  const font = root.attr('data-font') || 'Calibri';
  const fontSize = Number(root.attr('data-font-size') || 11);
  const header = root.attr('data-header') || '';
  const footer = root.attr('data-footer') || '';
  const pageSize = root.attr('data-page-size') === 'Letter' ? 'Letter' : 'A4';
  const landscape = root.attr('data-orientation') === 'landscape';
  const margins = {
    top: convertMillimetersToTwip(Number(root.attr('data-margin-top') || 20)),
    right: convertMillimetersToTwip(Number(root.attr('data-margin-right') || 18)),
    bottom: convertMillimetersToTwip(Number(root.attr('data-margin-bottom') || 20)),
    left: convertMillimetersToTwip(Number(root.attr('data-margin-left') || 18)),
  };
  let pageWidth = convertMillimetersToTwip(pageSize === 'Letter' ? 216 : 210);
  let pageHeight = convertMillimetersToTwip(pageSize === 'Letter' ? 279 : 297);
  if (landscape) {
    const swapped = pageWidth;
    pageWidth = pageHeight;
    pageHeight = swapped;
  }

  const children: Array<Paragraph | Table> = [];
  const thinBorder = { style: BorderStyle.SINGLE, size: 4, color: 'C5CDD6' };
  const borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

  $('article')
    .children()
    .each((_, node) => {
      const el = $(node);
      const tag = node.type === 'tag' ? node.name : '';

      if (tag === 'h1') {
        const isTitle = el.hasClass('doc-title');
        children.push(
          new Paragraph({
            heading: isTitle ? HeadingLevel.TITLE : HeadingLevel.HEADING_1,
            keepNext: true,
            spacing: { after: isTitle ? 120 : 160 },
            border: isTitle
              ? {
                  bottom: {
                    color: hexForDocx(accent),
                    space: 1,
                    style: BorderStyle.SINGLE,
                    size: 12,
                  },
                }
              : undefined,
            children: [
              new TextRun({
                text: el.text(),
                bold: true,
                color: hexForDocx(accent),
                size: isTitle ? 44 : 32,
                font,
              }),
            ],
          }),
        );
        return;
      }
      if (tag === 'h2' || tag === 'h3') {
        children.push(
          new Paragraph({
            heading: tag === 'h2' ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
            keepNext: true,
            spacing: { after: 120 },
            children: [
              new TextRun({
                text: el.text(),
                bold: true,
                color: hexForDocx(accent),
                size: tag === 'h2' ? 26 : 24,
                font,
              }),
            ],
          }),
        );
        return;
      }
      if (tag === 'p') {
        const runs = runsFrom($, el);
        children.push(
          new Paragraph({
            alignment: alignmentFrom(el),
            spacing: { after: 160 },
            children:
              runs.length > 0
                ? runs
                : [new TextRun({ text: el.text(), italics: el.hasClass('doc-subtitle'), font })],
          }),
        );
        return;
      }
      if (tag === 'ul' && el.hasClass('checklist')) {
        el.children('li').each((__, item) => {
          const checked = $(item).hasClass('is-checked');
          children.push(
            new Paragraph({
              spacing: { after: 80 },
              children: [
                new TextRun({ text: `${checked ? '☑' : '☐'} `, font }),
                ...runsFrom($, $(item)),
              ],
            }),
          );
        });
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        el.children('li').each((__, item) => {
          children.push(
            new Paragraph({
              bullet: tag === 'ul' ? { level: 0 } : undefined,
              numbering: tag === 'ol' ? { reference: 'doc-numbering', level: 0 } : undefined,
              children: runsFrom($, $(item)),
            }),
          );
        });
        return;
      }
      if (tag === 'table') {
        const rows: TableRow[] = [];
        el.find('tr').each((rowIndex, row) => {
          const cells = $(row)
            .children('th,td')
            .toArray()
            .map((cell) => {
              const header = 'name' in cell && cell.name === 'th';
              return new TableCell({
                borders,
                verticalAlign: VerticalAlign.CENTER,
                width: { size: 20, type: WidthType.PERCENTAGE },
                shading: header ? { type: ShadingType.CLEAR, fill: hexForDocx(accent) } : undefined,
                margins: { top: 60, bottom: 60, left: 80, right: 80 },
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: $(cell).text(),
                        bold: header,
                        color: header ? 'FFFFFF' : hexForDocx(color),
                        font,
                        size: Math.round(fontSize * 2),
                      }),
                    ],
                  }),
                ],
              });
            });
          rows.push(
            new TableRow({ children: cells, tableHeader: rowIndex === 0, cantSplit: true }),
          );
        });
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
        return;
      }
      if (tag === 'figure') {
        const img = el.find('img').first();
        const parsed = parseDataUri(img.attr('src') ?? '');
        const caption = el.find('figcaption').text();
        if (!parsed) {
          children.push(new Paragraph({ children: [new TextRun({ text: '[Bild fehlt]', font })] }));
          return;
        }
        const widthMm = widthMmFromStyle(img.attr('style'));
        children.push(
          new Paragraph({
            alignment: alignmentFrom(el),
            spacing: { before: 120, after: caption ? 40 : 160 },
            children: [
              new ImageRun({
                type: parsed.format,
                data: parsed.data,
                transformation: {
                  width: Math.round((widthMm * 96) / 25.4),
                  height: Math.round((widthMm / 1.5) * (96 / 25.4)),
                },
                altText: {
                  title: img.attr('alt') || 'Bild',
                  description: img.attr('alt') || 'Bild',
                  name: img.attr('alt') || 'Bild',
                },
              }),
            ],
          }),
        );
        if (caption) {
          children.push(
            new Paragraph({
              spacing: { after: 160 },
              children: [
                new TextRun({ text: caption, italics: true, size: 18, color: '555555', font }),
              ],
            }),
          );
        }
        return;
      }
      if (tag === 'aside') {
        const title = el.find('.callout-title').text();
        const text = el.children('p').not('.callout-title').text() || el.text();
        children.push(
          new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: 'F4F7FB' },
            border: {
              left: { color: hexForDocx(accent), space: 8, style: BorderStyle.SINGLE, size: 24 },
            },
            spacing: { after: 200 },
            children: [
              new TextRun({
                text: title ? `${title}: ${text}` : text,
                font,
                size: Math.round(fontSize * 2),
              }),
            ],
          }),
        );
        return;
      }
      if (tag === 'div' && el.hasClass('page-break')) {
        children.push(new Paragraph({ children: [new PageBreak()] }));
        return;
      }
      if (tag === 'div' && el.hasClass('spacer')) {
        children.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun('')] }));
        return;
      }
      if (tag === 'hr') {
        children.push(
          new Paragraph({
            border: {
              bottom: { color: hexForDocx(accent), space: 1, style: BorderStyle.SINGLE, size: 12 },
            },
            spacing: { after: 200 },
            children: [new TextRun('')],
          }),
        );
      }
    });

  const document = new Document({
    numbering: {
      config: [
        {
          reference: 'doc-numbering',
          levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font, size: Math.round(fontSize * 2), color: hexForDocx(color) },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: pageWidth,
              height: pageHeight,
              orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
            },
            margin: margins,
          },
        },
        headers: {
          default: new Header({
            children: header
              ? [
                  new Paragraph({
                    children: [new TextRun({ text: header, size: 18, color: '666666', font })],
                  }),
                ]
              : [],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: footer ? `${footer}  ` : '',
                    size: 18,
                    color: '666666',
                    font,
                  }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '666666', font }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}
