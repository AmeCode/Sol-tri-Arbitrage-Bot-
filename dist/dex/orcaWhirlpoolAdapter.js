import { PublicKey } from '@solana/web3.js';
import { WhirlpoolContext, ORCA_WHIRLPOOL_PROGRAM_ID, buildWhirlpoolClient, swapQuoteByInputToken, } from '@orca-so/whirlpools-sdk';
import Decimal from 'decimal.js-light';
import { Percentage } from '@orca-so/common-sdk';
import { CFG } from '../config.js';
/**
 * Create an Orca Whirlpool PoolEdge (both directions are created by builder.ts).
 */
export function makeOrcaEdge(whirlpool, mintA, mintB, ctx) {
    const poolPk = new PublicKey(whirlpool);
    const client = buildWhirlpoolClient(ctx);
    function getInputMint(from) {
        if (from === mintA)
            return new PublicKey(mintA);
        if (from === mintB)
            return new PublicKey(mintB);
        throw new Error(`orca: direction mismatch: from=${from} not in [${mintA}, ${mintB}]`);
    }
    return {
        id: `orca:${whirlpool}`,
        from: mintA,
        to: mintB,
        feeBps: 0,
        async quoteOut(amountIn) {
            const pool = await client.getPool(poolPk);
            const inputMint = getInputMint(this.from);
            const slippage = Percentage.fromFraction(CFG.maxSlippageBps, 10_000);
            const quote = await swapQuoteByInputToken(pool, inputMint, new Decimal(amountIn.toString()), slippage, ctx.program.programId, ctx.fetcher, true);
            return BigInt(quote.estimatedAmountOut.toFixed(0));
        },
        async buildSwapIx(amountIn, _minOut, _user) {
            const pool = await client.getPool(poolPk);
            const inputMint = getInputMint(this.from);
            const slippage = Percentage.fromFraction(CFG.maxSlippageBps, 10_000);
            const quote = await swapQuoteByInputToken(pool, inputMint, new Decimal(amountIn.toString()), slippage, ctx.program.programId, ctx.fetcher, true);
            const tb = await pool.swap(quote);
            return tb.compressIx(false).instructions;
        }
    };
}
/** Build an Orca Whirlpool context (dummy wallet is fine for read-only). */
export function initOrcaCtx(conn, walletPk) {
    const dummyWallet = { publicKey: walletPk };
    return WhirlpoolContext.from(conn, dummyWallet, ORCA_WHIRLPOOL_PROGRAM_ID);
}
//# sourceMappingURL=orcaWhirlpoolAdapter.js.map