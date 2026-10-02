const MIME_BY_EXTENSION: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

function mimeTypeFor(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** Tool result whose file LibreChat stores as a chat attachment. No download URL. */
export function documentAttachment(filename: string, data: Buffer) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Dokument erstellt und als Dateianhang beigefügt: ${filename} (${data.length} Bytes). ` +
          'Der Anhang erscheint automatisch in der Antwort. Gib keine Download-URL aus.',
      },
      {
        type: 'resource' as const,
        resource: {
          uri: `file:///${filename}`,
          mimeType: mimeTypeFor(filename),
          blob: data.toString('base64'),
        },
      },
    ],
  };
}
