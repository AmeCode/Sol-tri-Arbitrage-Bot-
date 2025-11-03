import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { WhirlpoolContext, ORCA_WHIRLPOOL_PROGRAM_ID, buildWhirlpoolClient, swapQuoteByInputToken, increaseComputeBudgetIx, PDAUtil, WhirlpoolData } from '@orca-so/whirlpools-sdk';
import Decimal from 'decimal.js';
import { PoolEdge } from '../graph/types.js';
import { WsAccountCache } from '../utils/wsCache.js';
import { CFG } from '../config.js';

export function makeOrcaEdge(whirlpool: string, mintA: string, mintB: string, ctx: WhirlpoolContext, cache: WsAccountCache): PoolEdge {
  const poolPk = new PublicKey(whirlpool);
  const client = buildWhirlpoolClient(ctx);

  function direction(from: string, to: string) {
    if (from === mintA && to === mintB) return { aToB: true };
    if (from === mintB && to === mintA) return { aToB: false };
    throw new Error(`orca direction mismatch ${from} -> ${to}`);
  }

  return {
    id: `orca:${whirlpool}`,
    from: mintA,
    to: mintB,
    feeBps: 0,

    async quoteOut(amountIn: bigint): Promise<bigint> {
      const pool = await client.getPool(poolPk);
      const aToB = direction(this.from, this.to).aToB;

      // Prefer cached pool account freshness (subscription happens in builder)
      // Quote in base units using Decimal
      const q = await swapQuoteByInputToken(
        pool,
        aToB,
        new Decimal(amountIn.toString()),
        CFG.maxSlippageBps,
        ctx.program.programId,
        ctx.fetcher,
        true
      );

      return BigInt(q.estimatedAmountOut.toFixed(0));
    },

    async buildSwapIx(amountIn: bigint, _minOut: bigint, _user: PublicKey): Promise<TransactionInstruction[]> {
      const pool = await client.getPool(poolPk);
      const aToB = direction(this.from, this.to).aToB;

      const q = await swapQuoteByInputToken(
        pool,
        aToB,
        new Decimal(amountIn.toString()),
        CFG.maxSlippageBps,
        ctx.program.programId,
        ctx.fetcher,
        true
      );

      const txb = pool.swapIx(q);
      const cuIx = increaseComputeBudgetIx(1_000_000);
      return [cuIx, ...txb.compressIx(false).instructions];
    }
  };
}

export function initOrcaCtx(conn: any, walletPk: PublicKey) {
  const dummyWallet = { publicKey: walletPk } as any;
  return WhirlpoolContext.from(conn, dummyWallet, ORCA_WHIRLPOOL_PROGRAM_ID);
}

