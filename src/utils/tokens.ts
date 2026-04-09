/**
 * Approximate token count. Good enough for budget decisions.
 * Rule of thumb: ~4 chars per token for English/code.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Trim text to fit within a token budget.
 */
export function trimToTokenBudget(text: string, budget: number): string {
  const maxChars = budget * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... [truncated]';
}
