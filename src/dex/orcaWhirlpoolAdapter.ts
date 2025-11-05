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
      try {
        const pool = await client.getPool(poolPk);
        const inputMint = getInputMint(this.from);
        const slippage = Percentage.fromFraction(CFG.maxSlippageBps, 10_000);

        const quote = await swapQuoteByInputToken(
          pool,
          inputMint,
          new BN(amountIn.toString(), 10),
          slippage,
          ctx.program.programId,
          ctx.fetcher,
          { maxAge: 0 },
          UseFallbackTickArray.Never
        );

        const out = quote.estimatedAmountOut;
        if (out.lte(new BN(0))) {
          console.warn(`[orca] non-positive out for ${this.id} -> ${out.toString()}`);
          return 0n;
        }
        return BigInt(out.toString());
      } catch (e) {
        console.warn(`[orca] quote error ${this.id}:`, (e as Error).message);
        return 0n;
      }
    },

    async buildSwapIx(amountIn: bigint, _minOut: bigint, _user: PublicKey): Promise<TransactionInstruction[]> {
      try {
        const pool = await client.getPool(poolPk);
        const inputMint = getInputMint(this.from);
        const slippage = Percentage.fromFraction(CFG.maxSlippageBps, 10_000);

        const quote = await swapQuoteByInputToken(
          pool,
          inputMint,
          new BN(amountIn.toString(), 10),
          slippage,
          ctx.program.programId,
          ctx.fetcher,
          { maxAge: 0 },
          UseFallbackTickArray.Never
        );

        const tb = await pool.swap(quote);
        return tb.compressIx(false).instructions;
      } catch (e) {
        console.warn(`[orca] buildSwapIx error ${this.id}:`, (e as Error).message);
        return [];
      }
    }
  };
}

export function initOrcaCtx(conn: any, walletPk: PublicKey) {
  const dummyWallet = { publicKey: walletPk } as any;
  return WhirlpoolContext.from(conn, dummyWallet, ORCA_WHIRLPOOL_PROGRAM_ID);
}

