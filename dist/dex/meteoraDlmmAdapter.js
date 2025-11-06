import { PublicKey, } from '@solana/web3.js';
import BN from 'bn.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { DLMM, SwapDirection } from '@meteora-ag/dlmm';
import { ensureAtaIx, wrapSolIntoAta } from '../tokenAta.js';
// ───────────────────────────────────────────────────────────────────────────────
// Config / small utils
// ───────────────────────────────────────────────────────────────────────────────
const DEBUG = process.env.DLMM_DEBUG === '1';
function log(...args) {
    if (DEBUG)
        console.debug('[DLMM]', ...args);
}
function toPk(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${label} is empty or not a string: ${String(value)}`);
    }
    const s = value.trim();
    try {
        return new PublicKey(s);
    }
    catch {
        throw new Error(`${label} is not a valid Solana public key: '${s}'`);
    }
}
function assert(condition, msg) {
    if (!condition)
        throw new Error(msg);
}
// ───────────────────────────────────────────────────────────────────────────────
// Simple pool cache (avoid reloading DLMM state every call)
// ───────────────────────────────────────────────────────────────────────────────
const dlmmCache = new Map();
async function loadDlmm(connection, poolPk) {
    const k = poolPk.toBase58();
    const cached = dlmmCache.get(k);
    if (cached)
        return cached;
    const dlmm = await DLMM.create(connection, poolPk);
    dlmmCache.set(k, dlmm);
    return dlmm;
}
// ───────────────────────────────────────────────────────────────────────────────
// Factory
// NOTE: we capture a Connection so we can use the SDK inside quote/swap.
// Update your builder to pass the read connection into this factory.
// ───────────────────────────────────────────────────────────────────────────────
export function makeMeteoraEdge(connection, poolId, inputMint, outputMint) {
    const poolPk = toPk(poolId, 'DLMM pool id');
    const inMintPk = toPk(inputMint, 'inputMint');
    const outMintPk = toPk(outputMint, 'outputMint');
    return {
        id: `meteora:${poolPk.toBase58()}`,
        from: inMintPk.toBase58(),
        to: outMintPk.toBase58(),
        feeBps: 0,
        // Real quote via SDK (respects bins/liquidity)
        async quoteOut(amountIn) {
            if (amountIn <= 0n)
                return 0n;
            const dlmm = await loadDlmm(connection, poolPk);
            const mintA = dlmm.state.mintA;
            const mintB = dlmm.state.mintB;
            let direction;
            if (inMintPk.equals(mintA) && outMintPk.equals(mintB)) {
                direction = SwapDirection.AtoB;
            }
            else if (inMintPk.equals(mintB) && outMintPk.equals(mintA)) {
                direction = SwapDirection.BtoA;
            }
            else {
                // Pool doesn’t match requested pair; return 0 to drop this edge for this path.
                if (DEBUG) {
                    log('quoteOut: mint mismatch', {
                        pool: poolPk.toBase58(),
                        poolMintA: mintA.toBase58(),
                        poolMintB: mintB.toBase58(),
                        in: inMintPk.toBase58(),
                        out: outMintPk.toBase58(),
                    });
                }
                return 0n;
            }
            const quote = await dlmm.swapQuoteByInputToken(new BN(amountIn.toString()), direction);
            const out = BigInt(quote.amountOut.toString());
            if (DEBUG)
                log('quoteOut ok', {
                    pool: poolPk.toBase58(),
                    dir: direction === SwapDirection.AtoB ? 'AtoB' : 'BtoA',
                    amountIn: amountIn.toString(),
                    amountOut: out.toString(),
                });
            return out;
        },
        // Build the real DLMM swap ix(s) via SDK
        async buildSwapIx(amountIn, minOut, user) {
            assert(amountIn > 0n, 'amountIn must be > 0');
            assert(minOut >= 0n, 'minOut must be >= 0');
            const dlmm = await loadDlmm(connection, poolPk);
            const mintA = dlmm.state.mintA;
            const mintB = dlmm.state.mintB;
            let direction;
            if (inMintPk.equals(mintA) && outMintPk.equals(mintB)) {
                direction = SwapDirection.AtoB;
            }
            else if (inMintPk.equals(mintB) && outMintPk.equals(mintA)) {
                direction = SwapDirection.BtoA;
            }
            else {
                throw new Error('DLMM pool does not match input/output mints');
            }
            const setupIxs = [];
            // Ensure ATAs / wrap WSOL on the *input* side
            let sourceAta;
            if (inMintPk.equals(NATIVE_MINT)) {
                const wrapped = wrapSolIntoAta(user, user, amountIn);
                setupIxs.push(...wrapped.ixs);
                sourceAta = wrapped.ata;
            }
            else {
                const ensured = ensureAtaIx(user, user, inMintPk);
                setupIxs.push(...ensured.ixs);
                sourceAta = ensured.ata;
            }
            // Ensure output ATA exists
            const ensuredDst = ensureAtaIx(user, user, outMintPk);
            setupIxs.push(...ensuredDst.ixs);
            const destinationAta = ensuredDst.ata;
            // Quote again for safety (and for consistent bins) then enforce minOut
            const quote = await dlmm.swapQuoteByInputToken(new BN(amountIn.toString()), direction);
            const expectedOut = BigInt(quote.amountOut.toString());
            if (expectedOut < minOut) {
                throw new Error(`DLMM quote below minOut: got ${expectedOut}, need >= ${minOut}`);
            }
            // Build real DLMM swap via SDK
            const { innerTransaction } = await dlmm.swap({
                owner: user,
                direction,
                amountIn: new BN(amountIn.toString()),
                minAmountOut: new BN(minOut.toString()),
                // The SDK resolves vaults, bin arrays, token program, etc.
                // We’ve created/wrapped user ATAs above; DLMM swap will read/write them.
            });
            const dlmmIxs = innerTransaction.instructions;
            if (DEBUG) {
                log('buildSwapIx', {
                    pool: poolPk.toBase58(),
                    dir: direction === SwapDirection.AtoB ? 'AtoB' : 'BtoA',
                    ixs: dlmmIxs.length,
                    amountIn: amountIn.toString(),
                    minOut: minOut.toString(),
                    expectedOut: expectedOut.toString(),
                    sourceAta: sourceAta.toBase58(),
                    destinationAta: destinationAta.toBase58(),
                });
            }
            // Return prep + DLMM swap ixs (no SystemProgram/Allocate hack here!)
            return { ixs: [...setupIxs, ...dlmmIxs] };
        },
    };
}
//# sourceMappingURL=meteoraDlmmAdapter.js.map