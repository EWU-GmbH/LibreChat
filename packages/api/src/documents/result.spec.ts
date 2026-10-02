import { documentAttachment } from './result';

describe('documentAttachment', () => {
  const data = Buffer.from('docx-bytes');

  it('returns the file as an embedded resource and no download URL', () => {
    const result = documentAttachment('Anschreiben_DEKRA_Ausfallpauschale.docx', data);
    const text = result.content[0];
    const resource = result.content[1];

    expect(text?.type).toBe('text');
    expect(text && 'text' in text ? text.text : '').toContain(
      'Anschreiben_DEKRA_Ausfallpauschale.docx',
    );
    expect(text && 'text' in text ? text.text : '').toContain(`${data.length} Bytes`);
    expect(text && 'text' in text ? text.text : '').not.toMatch(/https?:\/\//);

    expect(resource?.type).toBe('resource');
    if (resource?.type !== 'resource') {
      return;
    }
    expect(resource.resource.uri).toBe('file:///Anschreiben_DEKRA_Ausfallpauschale.docx');
    expect(resource.resource.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(Buffer.from(resource.resource.blob, 'base64')).toEqual(data);
  });

  it('picks the spreadsheet and PDF media types', () => {
    expect(documentAttachment('tabelle.xlsx', data).content[1]?.resource.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(documentAttachment('brief.pdf', data).content[1]?.resource.mimeType).toBe(
      'application/pdf',
    );
  });
});
