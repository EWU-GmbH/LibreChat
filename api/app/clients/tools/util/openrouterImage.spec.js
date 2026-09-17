const {
  OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_GEMINI_IMAGE_MODEL,
  DEFAULT_OPENROUTER_OPENAI_IMAGE_MODEL,
  getOpenRouterApiKey,
  isOpenRouterBaseUrl,
  isOpenRouterModelId,
  createOpenRouterImageClient,
  generateImageViaOpenAICompatible,
} = require('~/app/clients/tools/util/openrouterImage');

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    images: {
      generate: jest.fn(),
    },
  }));
});

jest.mock('@librechat/api', () => ({
  extractBaseURL: jest.fn((url) => url.replace(/\/$/, '')),
  getProxyDispatcher: jest.fn(() => undefined),
}));

describe('openrouterImage util', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  it('reads OPENROUTER_API_KEY or OPENROUTER_KEY', () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_KEY;
    expect(getOpenRouterApiKey()).toBe('');

    process.env.OPENROUTER_KEY = 'or-key';
    expect(getOpenRouterApiKey()).toBe('or-key');

    process.env.OPENROUTER_API_KEY = 'or-api-key';
    expect(getOpenRouterApiKey()).toBe('or-api-key');
  });

  it('detects OpenRouter base URLs and model ids', () => {
    expect(isOpenRouterBaseUrl('https://openrouter.ai/api/v1')).toBe(true);
    expect(isOpenRouterBaseUrl('https://api.openai.com/v1')).toBe(false);
    expect(isOpenRouterModelId('google/gemini-2.5-flash-image')).toBe(true);
    expect(isOpenRouterModelId('gemini-2.5-flash-image')).toBe(false);
  });

  it('exposes OpenRouter defaults', () => {
    expect(OPENROUTER_BASE_URL).toContain('openrouter.ai');
    expect(DEFAULT_OPENROUTER_GEMINI_IMAGE_MODEL).toBe('google/gemini-2.5-flash-image');
    expect(DEFAULT_OPENROUTER_OPENAI_IMAGE_MODEL).toBe('openai/gpt-5-image');
  });

  it('generateImageViaOpenAICompatible returns b64_json', async () => {
    const generate = jest.fn().mockResolvedValue({
      data: [{ b64_json: 'abc123', media_type: 'image/png' }],
    });
    const client = { images: { generate } };

    const result = await generateImageViaOpenAICompatible({
      client,
      model: DEFAULT_OPENROUTER_OPENAI_IMAGE_MODEL,
      prompt: 'a cat',
    });

    expect(result).toEqual({ b64: 'abc123', mimeType: 'image/png' });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: DEFAULT_OPENROUTER_OPENAI_IMAGE_MODEL,
        prompt: 'a cat',
      }),
      undefined,
    );
  });

  it('createOpenRouterImageClient points at OpenRouter', () => {
    const OpenAI = require('openai');
    createOpenRouterImageClient({ apiKey: 'k' });
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'k',
        baseURL: OPENROUTER_BASE_URL,
      }),
    );
  });
});
