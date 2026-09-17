import { applyPiiProtection } from './pii';

describe('applyPiiProtection', () => {
  it('leaves the default request unchanged', () => {
    const llmConfig = { model: 'openrouter/auto' };

    applyPiiProtection(llmConfig, false);

    expect(llmConfig).toEqual({ model: 'openrouter/auto' });
  });

  it('adds the opt-in flag to model kwargs without dropping existing values', () => {
    const llmConfig: Record<string, unknown> = {
      model: 'openrouter/auto',
      modelKwargs: { provider: { zdr: true } },
    };

    applyPiiProtection(llmConfig, true);

    expect(llmConfig.modelKwargs).toEqual({
      provider: { zdr: true },
      pii_protection: true,
    });
  });
});
