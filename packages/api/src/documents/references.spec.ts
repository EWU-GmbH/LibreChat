import {
  hasDocumentImageReferences,
  LATEST_LIBRECHAT_IMAGE,
  resolveDocumentImageReferences,
} from './references';

describe('document image references', () => {
  it('resolves explicit and latest LibreChat images without mutating input', async () => {
    const input = {
      title: 'Bericht',
      blocks: [
        { type: 'paragraph', text: 'Einleitung' },
        { type: 'image', fileId: 'file_flux_123', alt: 'Flux' },
        { type: 'image', src: LATEST_LIBRECHAT_IMAGE, alt: 'Neu' },
      ],
    };
    const resolver = jest.fn(async ({ fileId }: { fileId: string }) => `data:image/png;${fileId}`);

    const result = await resolveDocumentImageReferences(input, resolver);

    expect(result).toEqual({
      title: 'Bericht',
      content: undefined,
      blocks: [
        { type: 'paragraph', text: 'Einleitung' },
        { type: 'image', src: 'data:image/png;file_flux_123', alt: 'Flux' },
        { type: 'image', src: 'data:image/png;latest', alt: 'Neu' },
      ],
    });
    expect(input.blocks[1]).toHaveProperty('fileId', 'file_flux_123');
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('resolves LibreChat references in Markdown content and serialized arguments', async () => {
    const input = JSON.stringify({
      title: 'Bericht',
      content: '![Erzeugtes Bild](lc-file:latest)',
    });

    const result = await resolveDocumentImageReferences(
      input,
      async ({ fileId }) => `data:image/jpeg;base64,${fileId}`,
    );

    expect(JSON.parse(result as string)).toMatchObject({
      content: '![Erzeugtes Bild](data:image/jpeg;base64,latest)',
    });
  });

  it('leaves ordinary document arguments unchanged', async () => {
    const input = { content: '![Logo](https://example.com/logo.png)' };
    const resolver = jest.fn();

    expect(hasDocumentImageReferences(input)).toBe(false);
    await expect(resolveDocumentImageReferences(input, resolver)).resolves.toBe(input);
    expect(resolver).not.toHaveBeenCalled();
  });
});
