import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Alignment, DocumentInput, ResolvedLayout, SheetInput, TextStyle } from './model';
import { hexForDocx, mapPdfFont, mmToPt, pageSizeMm, resolveBlocks, resolveLayout } from './model';
import { renderPdfViaService } from './pdfClient';
import { renderPrintHtml } from './printHtml';
import { loadBlockImages } from './images';
import { htmlToDocx } from './htmlToDocx';

export type { CellValue, SheetInput } from './model';

function headingSize(level: 1 | 2 | 3): number {
  if (level === 1) {
    return 16;
  }
  if (level === 2) {
    return 13;
  }
  return 12;
}

function clampSpacer(heightMm: number | undefined): number {
  return Math.min(Math.max(heightMm ?? 6, 1), 40);
}

export async function createDocx(input: DocumentInput): Promise<Buffer> {
  const html = await renderPrintHtml(input);
  return htmlToDocx(html);
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

function paintPdfChrome(
  document: PDFKit.PDFDocument,
  layout: ResolvedLayout,
  pageNumber: number,
): void {
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
  const footer = layout.footer;
  document.text(footer, margins.left, page.height - 24, {
    width: width / 2,
    align: 'left',
    lineBreak: false,
    height: 12,
  });
  document.text(`Seite ${pageNumber}`, margins.left + width / 2, page.height - 24, {
    width: width / 2,
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
  const padding = 5;
  const fontSize = 10;
  const drawRow = (values: string[], header: boolean) => {
    document.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
    let height = 18;
    for (let index = 0; index < columns; index += 1) {
      const text = values[index] ?? '';
      height = Math.max(
        height,
        document.heightOfString(text, { width: colWidth - padding * 2 }) + padding * 2,
      );
    }
    if (document.y + height > document.page.height - document.page.margins.bottom) {
      document.addPage();
    }
    const y = document.y;
    for (let index = 0; index < columns; index += 1) {
      const x = document.page.margins.left + index * colWidth;
      document.save();
      if (header) {
        document.rect(x, y, colWidth, height).fill(layout.accentColor);
        document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(fontSize);
      } else {
        document.rect(x, y, colWidth, height).strokeColor('#cccccc').stroke();
        document.fillColor(layout.defaultColor).font('Helvetica').fontSize(fontSize);
      }
      document.text(values[index] ?? '', x + padding, y + padding, {
        width: colWidth - padding * 2,
        lineBreak: true,
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

async function createPdfWithPdfKit(input: DocumentInput): Promise<Buffer> {
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
    let pageNumber = 1;
    document.on('pageAdded', () => {
      pageNumber += 1;
      paintPdfChrome(document, layout, pageNumber);
    });
    paintPdfChrome(document, layout, pageNumber);

    if (!layout.hideTitle) {
      applyPdfStyle(document, layout, undefined, {
        bold: true,
        size: 20,
        color: layout.accentColor,
      });
      document.text(input.title, { align: 'left' });
      if (layout.subtitle) {
        applyPdfStyle(document, layout, undefined, { italic: true, size: 11, color: '#444444' });
        document.text(layout.subtitle, { align: 'left' });
      }
      document.moveDown();
    }

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.type === 'heading') {
        applyPdfStyle(document, layout, block.style, {
          bold: true,
          size: headingSize(block.level),
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
      if (block.type === 'checklist') {
        applyPdfStyle(document, layout, block.style);
        for (let itemIndex = 0; itemIndex < block.items.length; itemIndex += 1) {
          const mark = block.checked?.[itemIndex] ? '☑' : '☐';
          document.text(`${mark} ${block.items[itemIndex]}`, {
            align: 'left',
            indent: 8,
            lineGap: 2,
          });
        }
        document.moveDown(0.4);
        continue;
      }
      if (block.type === 'callout') {
        applyPdfStyle(document, layout, undefined, { color: layout.accentColor });
        document.text(block.title ? `${block.title}: ${block.text}` : block.text, {
          align: 'left',
          lineGap: 3,
        });
        document.moveDown(0.5);
        continue;
      }
      if (block.type === 'pageBreak') {
        document.addPage();
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
        document.y += drawHeight + 6;
        if (image.caption) {
          applyPdfStyle(document, layout, undefined, { italic: true, size: 9, color: '#555555' });
          document.text(image.caption, { align: pdfAlign(image.align), width: usable });
        }
        document.y += 8;
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

export async function createPdf(
  input: DocumentInput,
  deps?: { fetch?: typeof fetch },
): Promise<Buffer> {
  const html = await renderPrintHtml(input);
  const layout = resolveLayout(input.layout);
  const fromService = await renderPdfViaService(html, layout, {
    fetch: deps?.fetch ?? globalThis.fetch.bind(globalThis),
  });
  if (fromService) {
    return fromService;
  }
  return createPdfWithPdfKit(input);
}
