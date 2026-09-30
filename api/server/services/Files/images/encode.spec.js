const mockPrepareImagePayload = jest.fn();

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    prepareImagePayload: mockPrepareImagePayload,
    getDownloadStream: jest.fn(),
  })),
}));

const { logger } = require('@librechat/data-schemas');
const { encodeAndFormat } = require('./encode');

const req = { body: {}, user: { id: 'user-1' } };
const imageBytes = Buffer.alloc(32, 7).toString('base64');

function imageFile(fileId) {
  return {
    source: 'local',
    file_id: fileId,
    filepath: `/images/user-1/${fileId}.png`,
    filename: `${fileId}.png`,
    type: 'image/png',
    height: 8,
    width: 8,
  };
}

describe('encodeAndFormat local images', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips a missing local file and still returns the other image', async () => {
    mockPrepareImagePayload.mockImplementation(async (_request, file) => {
      if (file.file_id === 'missing') {
        const error = new Error(
          "ENOENT: no such file or directory, open '/app/client/public/images/user-1/missing.png'",
        );
        error.code = 'ENOENT';
        throw error;
      }
      return [file, imageBytes];
    });

    const result = await encodeAndFormat(req, [imageFile('missing'), imageFile('present')], {
      provider: 'openAI',
    });

    expect(result.files.map((file) => file.file_id)).toEqual(['present']);
    expect(result.image_urls).toHaveLength(1);
    expect(result.image_urls[0].image_url.url).toBe(`data:image/png;base64,${imageBytes}`);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warning = String(logger.warn.mock.calls[0][0]);
    expect(warning).toContain('file_id: missing');
    expect(warning).not.toContain('/app/');
    expect(warning).not.toContain('ENOENT');
  });

  it('throws when image preparation fails for a reason other than a missing file', async () => {
    mockPrepareImagePayload.mockRejectedValue(
      Object.assign(new Error('disk quota exceeded'), { code: 'EIO' }),
    );

    await expect(
      encodeAndFormat(req, [imageFile('present')], { provider: 'openAI' }),
    ).rejects.toThrow('disk quota exceeded');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still throws when a readable image fails validation', async () => {
    mockPrepareImagePayload.mockImplementation(async (_request, file) => [
      file,
      Buffer.from('x').toString('base64'),
    ]);

    await expect(encodeAndFormat(req, [imageFile('tiny')], { provider: 'openAI' })).rejects.toThrow(
      'Image validation failed for tiny.png',
    );
  });
});
