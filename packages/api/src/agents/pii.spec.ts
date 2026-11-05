import { applyPiiProtection, PII_PROTECTION_MIN_TIMEOUT_MS } from './pii';

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
    expect(llmConfig.timeout).toBe(PII_PROTECTION_MIN_TIMEOUT_MS);
  });

  it('raises a too-low timeout so cold GLiNER load is not aborted', () => {
    const llmConfig: Record<string, unknown> = {
      model: 'openrouter/auto',
      timeout: 60_000,
    };

    applyPiiProtection(llmConfig, true);

    expect(llmConfig.timeout).toBe(PII_PROTECTION_MIN_TIMEOUT_MS);
  });

  it('keeps an already-sufficient timeout', () => {
    const llmConfig: Record<string, unknown> = {
      model: 'openrouter/auto',
      timeout: 300_000,
    };

    applyPiiProtection(llmConfig, true);

    expect(llmConfig.timeout).toBe(300_000);
  });
});
