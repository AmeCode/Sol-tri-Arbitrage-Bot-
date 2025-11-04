import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  WhirlpoolContext,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  buildWhirlpoolClient,
  swapQuoteByInputToken,
  UseFallbackTickArray,
} from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import BN from 'bn.js';
import { PoolEdge } from '../graph/types.js';
import { CFG } from '../config.js';

export function makeOrcaEdge(
  whirlpool: string,
  mintA: string,
  mintB: string,
  ctx: WhirlpoolContext,
): PoolEdge {
  const poolPk = new PublicKey(whirlpool);
  const client = buildWhirlpoolClient(ctx);

  function getInputMint(from: string): PublicKey {
    if (from === mintA) return new PublicKey(mintA);
    if (from === mintB) return new PublicKey(mintB);
    throw new Error(`orca: direction mismatch: from=${from} not in [${mintA}, ${mintB}]`);
  }

  return {
    id: `orca:${whirlpool}`,
    from: mintA,
    to: mintB,
    feeBps: 0,

    async quoteOut(amountIn: bigint): Promise<bigint> {
      const pool = await client.getPool(poolPk);
      const inputMint = getInputMint(this.from);
      const slippage = Percentage.fromFraction(CFG.maxSlippageBps, 10_000);

      const quote = await swapQuoteByInputToken(
        pool,
        inputMint,
        new BN(amountIn.toString()),          // BN, not Decimal
        slippage,
        ctx.program.programId,
        ctx.fetcher,
        { maxAge: 0 },                        // <-- VALID SimpleAccountFetchOptions
        UseFallbackTickArray.Never            // (or .Auto / .Always)
      );
      return BigInt(quote.estimatedAmountOut.toString());
    },

    async buildSwapIx(amountIn: bigint, _minOut: bigint, _user: PublicKey): Promise<TransactionInstruction[]> {
      const pool = await client.getPool(poolPk);
      const inputMint = getInputMint(this.from);
      const slippage = Percentage.fromFraction(CFG.maxSlippageBps, 10_000);

      const quote = await swapQuoteByInputToken(
        pool,
        inputMint,
        new BN(amountIn.toString()),
        slippage,
        ctx.program.programId,
        ctx.fetcher,
        { maxAge: 0 },                        // <-- remove `refresh`
        UseFallbackTickArray.Never
      );

      const tb = await pool.swap(quote);
      return tb.compressIx(false).instructions;
    }
  };
}

export function initOrcaCtx(conn: any, walletPk: PublicKey) {
  const dummyWallet = { publicKey: walletPk } as any;
  return WhirlpoolContext.from(conn, dummyWallet, ORCA_WHIRLPOOL_PROGRAM_ID);
}

