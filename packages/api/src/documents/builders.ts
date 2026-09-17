import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

export type CellValue = string | number | boolean | null;

export interface SheetInput {
  name: string;
  rows: CellValue[][];
}

const headingLevels = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const;

function createDocxParagraph(line: string): Paragraph {
  const heading = /^(#{1,3})\s+(.+)$/.exec(line);
  if (heading) {
    const level = heading[1].length as keyof typeof headingLevels;
    return new Paragraph({
      heading: headingLevels[level],
      children: [new TextRun(heading[2])],
    });
  }

  const bullet = /^[-*]\s+(.+)$/.exec(line);
  if (bullet) {
    return new Paragraph({
      bullet: { level: 0 },
      children: [new TextRun(bullet[1])],
    });
  }

  return new Paragraph({ children: [new TextRun(line)] });
}

export async function createDocx(title: string, content: string): Promise<Buffer> {
  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun(title)],
    }),
    ...content.split(/\r?\n/).map(createDocxParagraph),
  ];
  const document = new Document({ sections: [{ children }] });
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

export async function createPdf(title: string, content: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const document = new PDFDocument({
      size: 'A4',
      margins: { top: 54, right: 54, bottom: 54, left: 54 },
      info: { Title: title, Creator: 'EWU Dokumente MCP' },
    });

    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    document.fontSize(20).text(title);
    document.moveDown();
    document.fontSize(11).text(content, { lineGap: 3 });
    document.end();
  });
}
