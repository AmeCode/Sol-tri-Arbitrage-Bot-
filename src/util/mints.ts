export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const SOL_NATIVE_MINT = '11111111111111111111111111111111';

const KNOWN_DECIMALS: Record<string, number> = {
  [WSOL_MINT]: 9,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6, // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6, // USDT
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 5, // BONK
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 6, // JUP
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 9, // mSOL
};

/**
 * Normalize a mint string so all routing logic uses a consistent identifier.
 */
export function canonicalMint(mint: string): string {
  const trimmed = mint?.trim();
  if (!trimmed) return trimmed;
  if (trimmed === SOL_NATIVE_MINT) return WSOL_MINT;
  return trimmed;
}

export function getMintDecimals(mint: string, fallback = 9): number {
  const canon = canonicalMint(mint);
  return KNOWN_DECIMALS[canon] ?? fallback;
}

/**
 * Pick a seed amount that roughly corresponds to ~1% of the mint's base units.
 */
export function seedForMint(mint: string): bigint {
  const decimals = getMintDecimals(mint);
  const base = BigInt(10) ** BigInt(decimals);
  return base / 100n;
}
