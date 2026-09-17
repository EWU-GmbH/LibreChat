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
}
