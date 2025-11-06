import BN from "bn.js";
/** Known token decimals (override here if you spot a mismatch). */
export const MINT_DECIMALS = {
    // SOL (wrapped) and mSOL are 9
    So11111111111111111111111111111111111111112: 9,
    mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 9,
    // USDC/USDT are 6
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6,
    // BONK 5, JUP 6 (adjust if your pools use different editions)
    DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5, // BONK
    JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 6 // JUP
};
/** Scale a decimal-like number (string) to on-chain base units (BN) using mint decimals. */
export function scaleToUnits(amount, mint) {
    const dec = MINT_DECIMALS[mint];
    if (dec === undefined)
        throw new Error(`Unknown mint decimals for ${mint}`);
    const [i, f = ""] = String(amount).split(".");
    if (f.length > dec)
        throw new Error(`Too many decimal places for ${mint} (${dec})`);
    const padded = i + (f + "0".repeat(dec)).slice(0, dec);
    return new BN(padded);
}
/** Convert BigInt lamports-like to BN (for SDKs that use BN). */
export function bigIntToBN(v) {
    return new BN(v.toString(), 10);
}
/** Given a base size ladder (as human sizes for the *input mint*), produce BN ladder. */
export function makeSizeLadder(humanSizes, inputMint) {
    return humanSizes.map(s => scaleToUnits(s, inputMint));
}
//# sourceMappingURL=amounts.js.map