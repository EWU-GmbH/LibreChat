import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import {
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  AlignmentType,
  Packer,
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
import type {
  Alignment,
  ContentBlock,
  DocumentInput,
  PreparedImage,
  ResolvedLayout,
  SheetInput,
  TextStyle,
} from './model';
import {
  hexForDocx,
  mapPdfFont,
  mmToPt,
  mmToPx,
  pageSizeMm,
  resolveBlocks,
  resolveLayout,
} from './model';
import { loadBlockImages } from './images';

export type { CellValue, SheetInput } from './model';

const headingLevels = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const;

function headingSize(level: 1 | 2 | 3, pdf: boolean): number {
  if (level === 1) {
    return pdf ? 16 : 18;
  }
  if (level === 2) {
    return pdf ? 13 : 14;
  }
  return 12;
}

const alignments: Record<Alignment, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

function textRun(
  text: string,
  layout: ResolvedLayout,
  style?: TextStyle,
  extra?: TextStyle,
): TextRun {
  const merged = { ...extra, ...style };
  return new TextRun({
    text,
    font: merged.font ?? layout.defaultFont,
    size: Math.round((merged.size ?? layout.defaultFontSize) * 2),
    color: hexForDocx(merged.color ?? layout.defaultColor),
    bold: merged.bold,
    italics: merged.italic,
    underline: merged.underline ? {} : undefined,
  });
}

function buildDocxParagraphs(
  block: ContentBlock,
  layout: ResolvedLayout,
  image: PreparedImage | undefined,
): Paragraph[] | Table {
  if (block.type === 'heading') {
    return [
      new Paragraph({
        heading: headingLevels[block.level],
        alignment: alignments[block.align ?? 'left'],
        children: [
          textRun(block.text, layout, block.style, {
            bold: true,
            color: layout.accentColor,
            size: headingSize(block.level, false),
          }),
        ],
      }),
    ];
  }

  if (block.type === 'paragraph') {
    return [
      new Paragraph({
        alignment: alignments[block.align ?? 'left'],
        spacing: { after: 160 },
        children: [textRun(block.text, layout, block.style)],
      }),
    ];
  }

  if (block.type === 'list') {
    return block.items.map(
      (item) =>
        new Paragraph({
          bullet: block.ordered ? undefined : { level: 0 },
          numbering: block.ordered ? { reference: 'doc-numbering', level: 0 } : undefined,
          children: [textRun(item, layout, block.style)],
        }),
    );
  }

  if (block.type === 'table') {
    const headers = block.headers ?? [];
    const width = Math.floor(100 / Math.max(headers.length || (block.rows[0]?.length ?? 1), 1));
    const cell = (value: string, header: boolean) =>
      new TableCell({
        width: { size: width, type: WidthType.PERCENTAGE },
        verticalAlign: VerticalAlign.CENTER,
        shading: header
          ? { type: ShadingType.CLEAR, fill: hexForDocx(layout.accentColor) }
          : undefined,
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
        children: [
          new Paragraph({
            children: [
              textRun(value, layout, undefined, {
                bold: header,
                color: header ? '#ffffff' : layout.defaultColor,
              }),
            ],
          }),
        ],
      });

    const rows = [
      ...(headers.length
        ? [new TableRow({ children: headers.map((header) => cell(header, true)) })]
        : []),
      ...block.rows.map(
        (row) => new TableRow({ children: row.map((value) => cell(value, false)) }),
      ),
    ];
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows,
    });
  }

  if (block.type === 'image') {
    if (!image) {
      return [new Paragraph({ children: [textRun(`[Bild fehlt: ${block.alt ?? ''}]`, layout)] })];
    }
    return [
      new Paragraph({
        alignment: alignments[image.align],
        spacing: { before: 120, after: 120 },
        children: [
          new ImageRun({
            type: image.format,
            data: image.data,
            transformation: {
              width: mmToPx(image.widthMm),
              height: mmToPx(image.heightMm),
            },
            altText: { title: image.alt, description: image.alt, name: image.alt },
          }),
        ],
      }),
    ];
  }

  if (block.type === 'spacer') {
    return [
      new Paragraph({
        spacing: { after: Math.round(clampSpacer(block.heightMm) * 20) },
        children: [new TextRun('')],
      }),
    ];
  }

  return [
    new Paragraph({
      border: {
        bottom: {
          color: hexForDocx(layout.accentColor),
          space: 1,
          style: BorderStyle.SINGLE,
          size: 12,
        },
      },
      spacing: { after: 200 },
      children: [new TextRun('')],
    }),
  ];
}

function clampSpacer(heightMm: number | undefined): number {
  return Math.min(Math.max(heightMm ?? 6, 1), 40);
}

function titleParagraph(title: string, layout: ResolvedLayout): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.LEFT,
    spacing: { after: 240 },
    children: [
      textRun(title, layout, undefined, {
        bold: true,
        size: 26,
        color: layout.accentColor,
      }),
    ],
  });
}

export async function createDocx(input: DocumentInput): Promise<Buffer> {
  const layout = resolveLayout(input.layout);
  const blocks = resolveBlocks(input);
  const images = await loadBlockImages(blocks);
  const page = pageSizeMm(layout);
  const children: Array<Paragraph | Table> = [];

  if (!layout.hideTitle) {
    children.push(titleParagraph(input.title, layout));
  }

  for (let index = 0; index < blocks.length; index += 1) {
    const rendered = buildDocxParagraphs(blocks[index], layout, images.get(index));
    if (Array.isArray(rendered)) {
      children.push(...rendered);
    } else {
      children.push(rendered);
    }
  }

  const headerParagraph = layout.header
    ? [
        new Paragraph({
          children: [textRun(layout.header, layout, undefined, { size: 9, color: '#666666' })],
        }),
      ]
    : [];
  const footerParagraph = [
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [
        textRun(layout.footer ? `${layout.footer} · ` : '', layout, undefined, {
          size: 9,
          color: '#666666',
        }),
        new TextRun({ children: [PageNumber.CURRENT] }),
      ],
    }),
  ];

  const document = new Document({
    numbering: {
      config: [
        {
          reference: 'doc-numbering',
          levels: [
            {
              level: 0,
              format: 'decimal',
              text: '%1.',
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertMillimetersToTwip(page.width),
              height: convertMillimetersToTwip(page.height),
              orientation:
                layout.orientation === 'landscape'
                  ? PageOrientation.LANDSCAPE
                  : PageOrientation.PORTRAIT,
            },
            margin: {
              top: convertMillimetersToTwip(layout.marginsMm.top),
              right: convertMillimetersToTwip(layout.marginsMm.right),
              bottom: convertMillimetersToTwip(layout.marginsMm.bottom),
              left: convertMillimetersToTwip(layout.marginsMm.left),
            },
          },
        },
        headers: { default: new Header({ children: headerParagraph }) },
        footers: { default: new Footer({ children: footerParagraph }) },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}

export async function createXlsx(sheets: SheetInput[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'EWU Dokumente MCP';
  workbook.created = new Date();

  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name.slice(0, 31));
    worksheet.addRows(sheet.rows);
    const firstRow = worksheet.getRow(1);
    firstRow.font = { bold: true };
    if (sheet.headerFill) {
      const fill = hexForDocx(sheet.headerFill);
      const fontColor = hexForDocx(sheet.headerColor ?? '#ffffff');
      firstRow.eachCell((cell) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: `FF${fill}` },
        };
        cell.font = { bold: true, color: { argb: `FF${fontColor}` } };
      });
    }
    for (let index = 1; index <= worksheet.columnCount; index += 1) {
      const column = worksheet.getColumn(index);
      let width = 10;
      column.eachCell((cell) => {
        const value = cell.value;
        const length = value == null ? 0 : String(value).length;
        width = Math.max(width, length);
      });
      column.width = Math.min(width + 2, 60);
    }
  }

  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data);
}

function applyPdfStyle(
  document: PDFKit.PDFDocument,
  layout: ResolvedLayout,
  style: TextStyle | undefined,
  extra?: TextStyle,
): void {
  const merged = { ...extra, ...style };
  document.font(mapPdfFont(merged.font ?? layout.defaultFont, merged));
  document.fontSize(merged.size ?? layout.defaultFontSize);
  document.fillColor(merged.color ?? layout.defaultColor);
}

function pdfAlign(align: Alignment | undefined): 'left' | 'center' | 'right' | 'justify' {
  return align ?? 'left';
}

function paintPdfChrome(document: PDFKit.PDFDocument, layout: ResolvedLayout, title: string): void {
  const page = document.page;
  const cursor = document.y;
  const margins = { ...page.margins };
  page.margins = { top: 0, right: 0, bottom: 0, left: 0 };

  if (layout.backgroundColor) {
    document.save();
    document.rect(0, 0, page.width, page.height).fill(layout.backgroundColor);
    document.restore();
  }
  const width = page.width - margins.left - margins.right;
  document.save();
  document.font('Helvetica').fontSize(9).fillColor('#666666');
  if (layout.header) {
    document.text(layout.header, margins.left, 16, {
      width,
      lineBreak: false,
      height: 12,
    });
  }
  const footer = layout.footer ? `${layout.footer} · ${title}` : title;
  document.text(footer, margins.left, page.height - 24, {
    width,
    align: 'right',
    lineBreak: false,
    height: 12,
  });
  document.restore();
  page.margins = margins;
  document.y = cursor;
}

function drawPdfTable(
  document: PDFKit.PDFDocument,
  layout: ResolvedLayout,
  headers: string[],
  rows: string[][],
): void {
  const usable = document.page.width - document.page.margins.left - document.page.margins.right;
  const columns = Math.max(headers.length || rows[0]?.length || 1, 1);
  const colWidth = usable / columns;
  const drawRow = (values: string[], header: boolean) => {
    const height = 22;
    if (document.y + height > document.page.height - document.page.margins.bottom) {
      document.addPage();
    }
    const y = document.y;
    for (let index = 0; index < columns; index += 1) {
      const x = document.page.margins.left + index * colWidth;
      document.save();
      if (header) {
        document.rect(x, y, colWidth, height).fill(layout.accentColor);
        document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10);
      } else {
        document.rect(x, y, colWidth, height).strokeColor('#cccccc').stroke();
        document.fillColor(layout.defaultColor).font('Helvetica').fontSize(10);
      }
      document.text(values[index] ?? '', x + 4, y + 6, {
        width: colWidth - 8,
        lineBreak: false,
      });
      document.restore();
    }
    document.y = y + height;
  };

  if (headers.length) {
    drawRow(headers, true);
  }
  for (const row of rows) {
    drawRow(row, false);
  }
  document.moveDown(0.6);
}

export async function createPdf(input: DocumentInput): Promise<Buffer> {
  const layout = resolveLayout(input.layout);
  const blocks = resolveBlocks(input);
  const images = await loadBlockImages(blocks);
  const page = pageSizeMm(layout);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const document = new PDFDocument({
      size: [mmToPt(page.width), mmToPt(page.height)],
      margins: {
        top: mmToPt(layout.marginsMm.top),
        right: mmToPt(layout.marginsMm.right),
        bottom: mmToPt(layout.marginsMm.bottom),
        left: mmToPt(layout.marginsMm.left),
      },
      info: { Title: input.title, Creator: 'EWU Dokumente MCP' },
    });

    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    document.on('pageAdded', () => paintPdfChrome(document, layout, input.title));
    paintPdfChrome(document, layout, input.title);

    if (!layout.hideTitle) {
      applyPdfStyle(document, layout, undefined, {
        bold: true,
        size: 20,
        color: layout.accentColor,
      });
      document.text(input.title, { align: 'left' });
      document.moveDown();
    }

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.type === 'heading') {
        applyPdfStyle(document, layout, block.style, {
          bold: true,
          size: headingSize(block.level, true),
          color: layout.accentColor,
        });
        document.text(block.text, { align: pdfAlign(block.align) });
        document.moveDown(0.4);
        continue;
      }
      if (block.type === 'paragraph') {
        applyPdfStyle(document, layout, block.style);
        document.text(block.text, { align: pdfAlign(block.align), lineGap: 3 });
        document.moveDown(0.4);
        continue;
      }
      if (block.type === 'list') {
        applyPdfStyle(document, layout, block.style);
        for (let itemIndex = 0; itemIndex < block.items.length; itemIndex += 1) {
          const prefix = block.ordered ? `${itemIndex + 1}. ` : '• ';
          document.text(`${prefix}${block.items[itemIndex]}`, {
            align: 'left',
            indent: 12,
            lineGap: 2,
          });
        }
        document.moveDown(0.4);
        continue;
      }
      if (block.type === 'table') {
        drawPdfTable(document, layout, block.headers ?? [], block.rows);
        continue;
      }
      if (block.type === 'image') {
        const image = images.get(index);
        if (!image) {
          continue;
        }
        const width = mmToPt(image.widthMm);
        const height = mmToPt(image.heightMm);
        const usable =
          document.page.width - document.page.margins.left - document.page.margins.right;
        const drawWidth = Math.min(width, usable);
        const drawHeight = height * (drawWidth / width);
        if (document.y + drawHeight > document.page.height - document.page.margins.bottom) {
          document.addPage();
        }
        let x = document.page.margins.left;
        if (image.align === 'center') {
          x = document.page.margins.left + (usable - drawWidth) / 2;
        }
        if (image.align === 'right') {
          x = document.page.width - document.page.margins.right - drawWidth;
        }
        document.image(image.data, x, document.y, { width: drawWidth, height: drawHeight });
        document.y += drawHeight + 8;
        continue;
      }
      if (block.type === 'spacer') {
        document.moveDown(clampSpacer(block.heightMm) / 6);
        continue;
      }
      document.save();
      document
        .moveTo(document.page.margins.left, document.y)
        .lineTo(document.page.width - document.page.margins.right, document.y)
        .strokeColor(layout.accentColor)
        .lineWidth(1)
        .stroke();
      document.restore();
      document.moveDown();
    }

    document.end();
  });
}
