import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { createDocx, createPdf, createXlsx } from './builders';

describe('document builders', () => {
  it('creates a readable DOCX with title and body', async () => {
    const buffer = await createDocx('Projektstatus', '## Zusammenfassung\n- Alles funktioniert');
    const extracted = await mammoth.extractRawText({ buffer });

    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(extracted.value).toContain('Projektstatus');
    expect(extracted.value).toContain('Alles funktioniert');
  });

  it('creates an XLSX with typed cells', async () => {
    const buffer = await createXlsx([
      {
        name: 'Umsatz',
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
  });

  it('creates a PDF document', async () => {
    const buffer = await createPdf('Prüfbericht', 'Das ist ein Test.');

    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(500);
  });
});
