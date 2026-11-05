/** Deduplicate server names while preserving selection order. */
export function normalizeMCPSelection(value: string[]): string[] {
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const name of value) {
    if (typeof name !== 'string' || name.length === 0 || seen.has(name)) {
      continue;
    }
    seen.add(name);
    selected.push(name);
  }
  return selected;
}
