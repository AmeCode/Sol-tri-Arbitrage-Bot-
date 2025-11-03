import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Clmm, ClmmPoolInfo, Percent, buildSimpleSwapTx } from '@raydium-io/raydium-sdk-v2';
import { PoolEdge } from '../graph/types.js';
import { CFG } from '../config.js';

export function makeRayClmmEdge(poolId: string, mintA: string, mintB: string, connection: any): PoolEdge {
  const pid = new PublicKey(poolId);

  function direction(from: string, to: string) {
    if (from === mintA && to === mintB) return { aToB: true };
    if (from === mintB && to === mintA) return { aToB: false };
    throw new Error(`raydium direction mismatch ${from} -> ${to}`);
  }

  async function fetchPool(): Promise<ClmmPoolInfo> {
    const pool = await Clmm.fetchPoolInfo({ connection, poolId: pid });
    if (!pool) throw new Error('raydium: pool not found');
    return pool;
  }

  return {
    id: `ray:${poolId}`,
    from: mintA,
    to: mintB,
    feeBps: 0,

    async quoteOut(amountIn: bigint): Promise<bigint> {
      const pool = await fetchPool();
      const slippage = new Percent(CFG.maxSlippageBps, 10_000);

      const { amountOut } = await buildSimpleSwapTx({
        connection,
        poolInfo: pool,
        ownerInfo: { useSOLBalance: true, wallet: new PublicKey('11111111111111111111111111111111') }, // owner irrelevant for quote
        inputMint: new PublicKey(this.from),
        inputAmount: amountIn,
        slippage
      });

      return amountOut ?? 0n;
    },

    async buildSwapIx(amountIn: bigint, _minOut: bigint, user: PublicKey): Promise<TransactionInstruction[]> {
      const pool = await fetchPool();
      const slippage = new Percent(CFG.maxSlippageBps, 10_000);

      const { innerTransactions } = await buildSimpleSwapTx({
        connection,
        poolInfo: pool,
        ownerInfo: { useSOLBalance: true, wallet: user },
        inputMint: new PublicKey(this.from),
        inputAmount: amountIn,
        slippage
      });

      const ixs: TransactionInstruction[] = [];
      for (const itx of innerTransactions ?? []) for (const ix of itx.instructions ?? []) ixs.push(ix);
      return ixs;
    }
  };
}

