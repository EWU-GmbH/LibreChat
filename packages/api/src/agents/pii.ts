/** Minimum LLM HTTP timeout when GLiNER may cold-load (~30s) before upstream. */
export const PII_PROTECTION_MIN_TIMEOUT_MS = 180_000;

export function applyPiiProtection(llmConfig: Record<string, unknown>, enabled: boolean): void {
  if (!enabled) {
    return;
  }

  const modelKwargs =
    llmConfig.modelKwargs != null &&
    typeof llmConfig.modelKwargs === 'object' &&
    !Array.isArray(llmConfig.modelKwargs)
      ? (llmConfig.modelKwargs as Record<string, unknown>)
      : {};
  llmConfig.modelKwargs = { ...modelKwargs, pii_protection: true };

  const currentTimeout = llmConfig.timeout;
  if (
    typeof currentTimeout !== 'number' ||
    !Number.isFinite(currentTimeout) ||
    currentTimeout < PII_PROTECTION_MIN_TIMEOUT_MS
  ) {
    llmConfig.timeout = PII_PROTECTION_MIN_TIMEOUT_MS;
  }
}
