/** Pierre's line grammar: negative numbers count backward from the last line. */
export function goToLineNumber(text: string, lineCount: number): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value === 0) return null;
  const maximum = Math.max(1, lineCount);
  return Math.min(maximum, Math.max(1, value < 0 ? maximum + 1 + value : value));
}
