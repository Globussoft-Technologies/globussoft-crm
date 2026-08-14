// Shared AI credit/token conversion — mirrors backend/lib/aiCreditLedger.js's
// TOKENS_PER_CREDIT. The wallet stays token-native on the backend for
// precision; every tenant/admin-facing surface displays credits (1 credit =
// 1,000 tokens) so the numbers read like a normal usage-based plan instead
// of raw LLM token counts.
export const TOKENS_PER_CREDIT = 1000;

export function tokensToCredits(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / TOKENS_PER_CREDIT);
}

export function creditsToTokens(credits) {
  const n = Number(credits);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * TOKENS_PER_CREDIT);
}

export function formatCredits(tokens) {
  return tokensToCredits(tokens).toLocaleString();
}
