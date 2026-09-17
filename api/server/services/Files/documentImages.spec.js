const { Readable } = require('node:stream');

const mockGetDownloadStream = jest.fn();

jest.mock('./strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({ getDownloadStream: mockGetDownloadStream })),
}));

jest.mock('~/models', () => ({
  getFiles: jest.fn(),
}));

const { getFiles } = require('~/models');
const { getStrategyFunctions } = require('./strategies');
const { resolveDocumentToolImages } = require('./documentImages');

const req = { config: { paths: { imageOutput: '/images' } } };
const user = { id: 'user-1' };

describe('resolveDocumentToolImages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('replaces the latest generated image with a data URI', async () => {
    getFiles.mockResolvedValue([
      {
        user: user.id,
        file_id: 'file_flux_1',
        filepath: '/images/user-1/flux.png',
        type: 'image/png',
        source: 'local',
        context: 'image_generation',
        bytes: 4,
      },
    ]);
    mockGetDownloadStream.mockResolvedValue(Readable.from([Buffer.from('flux')]));

    const result = await resolveDocumentToolImages({
      serverName: 'documents',
      toolName: 'create_docx',
      toolArguments: {
        title: 'Bericht',
        blocks: [{ type: 'image', src: 'lc-file:latest', alt: 'Flux' }],
      },
      req,
      user,
    });

    expect(getFiles).toHaveBeenCalledWith(
      {
        user: user.id,
        type: { $in: ['image/png', 'image/jpeg', 'image/jpg'] },
        context: 'image_generation',
      },
      { createdAt: -1 },
    );
    expect(getStrategyFunctions).toHaveBeenCalledWith('local');
    expect(result.blocks).toEqual([
      {
        type: 'image',
        alt: 'Flux',
        src: `data:image/png;base64,${Buffer.from('flux').toString('base64')}`,
      },
    ]);
  });

  it('rejects images that the requesting user does not own', async () => {
    getFiles.mockResolvedValue([]);

    await expect(
      resolveDocumentToolImages({
        serverName: 'documents',
        toolName: 'create_pdf',
        toolArguments: { title: 'x', blocks: [{ type: 'image', src: 'lc-file:file_other' }] },
        req,
        user,
      }),
    ).rejects.toThrow('LibreChat image not found or access denied');
    expect(mockGetDownloadStream).not.toHaveBeenCalled();
  });

  it('skips orphaned latest metadata and uses the next readable generated image', async () => {
    getFiles.mockResolvedValue([
      {
        user: user.id,
        file_id: 'file_orphan',
        filepath: '/images/user-1/orphan.png',
        type: 'image/png',
        source: 'local',
        context: 'image_generation',
        bytes: 12,
      },
      {
        user: user.id,
        file_id: 'file_ok',
        filepath: '/images/user-1/ok.png',
        type: 'image/png',
        source: 'local',
        context: 'image_generation',
        bytes: 4,
      },
    ]);
    const missing = Object.assign(
      new Error(
        "ENOENT: no such file or directory, open '/app/client/public/images/user-1/orphan.png'",
      ),
      { code: 'ENOENT' },
    );
    mockGetDownloadStream.mockImplementation(async (_req, filepath) => {
      if (filepath.includes('orphan')) {
        const stream = new Readable({
          read() {
            this.destroy(missing);
          },
        });
        return stream;
      }
      return Readable.from([Buffer.from('flux')]);
    });

    const result = await resolveDocumentToolImages({
      serverName: 'documents',
      toolName: 'create_docx',
      toolArguments: { blocks: [{ type: 'image', src: 'lc-file:latest' }] },
      req,
      user,
    });

    expect(result.blocks[0].src).toBe(
      `data:image/png;base64,${Buffer.from('flux').toString('base64')}`,
    );
    expect(mockGetDownloadStream).toHaveBeenCalledTimes(2);
  });

  it('rejects missing storage without leaking absolute filesystem paths', async () => {
    getFiles.mockResolvedValue([
      {
        user: user.id,
        file_id: 'file_orphan',
        filepath: '/images/user-1/orphan.png',
        type: 'image/png',
        source: 'local',
        context: 'image_generation',
        bytes: 12,
      },
    ]);
    const missing = Object.assign(
      new Error(
        "ENOENT: no such file or directory, open '/app/client/public/images/user-1/orphan.png'",
      ),
      { code: 'ENOENT' },
    );
    mockGetDownloadStream.mockImplementation(async () => {
      const stream = new Readable({
        read() {
          this.destroy(missing);
        },
      });
      return stream;
    });

    await expect(
      resolveDocumentToolImages({
        serverName: 'documents',
        toolName: 'create_docx',
        toolArguments: { blocks: [{ type: 'image', src: 'lc-file:latest' }] },
        req,
        user,
      }),
    ).rejects.toThrow('No generated image found for this user');

    await expect(
      resolveDocumentToolImages({
        serverName: 'documents',
        toolName: 'create_docx',
        toolArguments: { blocks: [{ type: 'image', src: 'lc-file:file_orphan' }] },
        req,
        user,
      }),
    ).rejects.toThrow('LibreChat image file is missing from storage');
  });

  it('rejects stored images larger than 2 MB', async () => {
    getFiles.mockResolvedValue([
      {
        user: user.id,
        file_id: 'file_big',
        filepath: '/images/user-1/big.png',
        type: 'image/png',
        source: 'local',
        bytes: 3 * 1024 * 1024,
      },
    ]);

    await expect(
      resolveDocumentToolImages({
        serverName: 'documents',
        toolName: 'create_docx',
        toolArguments: { title: 'x', blocks: [{ type: 'image', fileId: 'file_big' }] },
        req,
        user,
      }),
    ).rejects.toThrow('Document image exceeds 2 MB');
  });

  it('leaves other servers, tools, and image sources untouched', async () => {
    const httpsArguments = {
      title: 'x',
      blocks: [{ type: 'image', src: 'https://example.com/logo.png' }],
    };

    await expect(
      resolveDocumentToolImages({
        serverName: 'documents',
        toolName: 'create_xlsx',
        toolArguments: { filename: 'x.xlsx', sheets: [] },
        req,
        user,
      }),
    ).resolves.toEqual({ filename: 'x.xlsx', sheets: [] });
    await expect(
      resolveDocumentToolImages({
        serverName: 'other',
        toolName: 'create_docx',
        toolArguments: { blocks: [{ type: 'image', src: 'lc-file:latest' }] },
        req,
        user,
      }),
    ).resolves.toEqual({ blocks: [{ type: 'image', src: 'lc-file:latest' }] });
    await expect(
      resolveDocumentToolImages({
        serverName: 'documents',
        toolName: 'create_docx',
        toolArguments: httpsArguments,
        req,
        user,
      }),
    ).resolves.toBe(httpsArguments);
    expect(getFiles).not.toHaveBeenCalled();
  });

  it('resolves latest-1 to the second newest generated image', async () => {
    getFiles.mockResolvedValue([
      {
        user: user.id,
        file_id: 'file_new',
        filepath: '/images/user-1/new.png',
        type: 'image/png',
        source: 'local',
        context: 'image_generation',
        bytes: 3,
      },
      {
        user: user.id,
        file_id: 'file_old',
        filepath: '/images/user-1/old.png',
        type: 'image/png',
        source: 'local',
        context: 'image_generation',
        bytes: 3,
      },
    ]);
    mockGetDownloadStream.mockImplementation(async (_req, filepath) => {
      if (filepath.includes('new')) {
        return Readable.from([Buffer.from('new')]);
      }
      return Readable.from([Buffer.from('old')]);
    });

    const result = await resolveDocumentToolImages({
      serverName: 'documents',
      toolName: 'create_pdf',
      toolArguments: { blocks: [{ type: 'image', src: 'lc-file:latest-1' }] },
      req,
      user,
    });

    expect(result.blocks[0].src).toBe(
      `data:image/png;base64,${Buffer.from('old').toString('base64')}`,
    );
  });
});
