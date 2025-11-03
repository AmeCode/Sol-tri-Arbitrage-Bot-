import {
  PublicKey,
  TransactionInstruction,
  AccountInfo,
  EpochInfo,
  Connection,
} from '@solana/web3.js';
import {
  Api,
  Percent,
  PoolInfoLayout,
  PoolUtils,
  type ApiV3PoolInfoConcentratedItem,
} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import Decimal from 'decimal.js-light';
import { PoolEdge } from '../graph/types.js';
import { CFG } from '../config.js';

/**
 * Build a Raydium CLMM edge that quotes via PoolUtils.computeAmountOut ONLY.
 * Execution (buildSwapIx) uses makeSwapInstructionSimple.
 */
export function makeRayClmmEdge(
  poolId: string,
  mintA: string,
  mintB: string,
  connection: Connection
): PoolEdge {
  const pid = new PublicKey(poolId);

  // REST client for Raydium metadata (programId, token info, config, price, …)
  const api = new Api({ cluster: 'mainnet', timeout: 12_000 });

  function direction(from: string, to: string) {
    if (from === mintA && to === mintB) return { aToB: true };
    if (from === mintB && to === mintA) return { aToB: false };
    throw new Error(`raydium direction mismatch ${from} -> ${to}`);
  }

  /** Raw on-chain pool account (for fast validation / optional use). */
  type DecodedClmmPool = ReturnType<typeof PoolInfoLayout.decode> & { poolId: PublicKey };
  async function fetchPoolAccount(): Promise<DecodedClmmPool> {
    const acc = (await connection.getAccountInfo(pid)) as AccountInfo<Buffer> | null;
    if (!acc) throw new Error('raydium: pool not found');
    const state = PoolInfoLayout.decode(acc.data);
    return { poolId: pid, ...state };
  }

  /**
   * Pull the full ApiV3 pool record we need to build a ComputeClmmPoolInfo
   * (mintA/mintB objects, config, price, programId).
   */
  async function fetchApiPool(): Promise<ApiV3PoolInfoConcentratedItem> {
    const res = await api.fetchPoolById({ ids: poolId });
    const item = res.find((p) => p.id === poolId);
    if (!item) throw new Error(`raydium: api pool not found for ${poolId}`);
    if (item.type !== 'Concentrated') {
      throw new Error(`raydium: pool ${poolId} is not a CLMM pool`);
    }
    return item as ApiV3PoolInfoConcentratedItem;
  }

  /**
   * Build the ComputeClmmPoolInfo + tickArrayCache the compute path requires.
   * - ComputeClmmPoolInfo via PoolUtils.fetchComputeClmmInfo
   * - tick arrays via PoolUtils.fetchMultiplePoolTickArrays
   */
  async function buildComputeInputs() {
    const apiPool = await fetchApiPool();

    // Optionally pass decoded RPC bytes to avoid a 2nd fetch inside PoolUtils
    const rpcAcc = (await connection.getAccountInfo(pid)) as AccountInfo<Buffer> | null;
    const rpcData = rpcAcc ? PoolInfoLayout.decode(rpcAcc.data) : undefined;

    const computePool = await PoolUtils.fetchComputeClmmInfo({
      connection,
      poolInfo: {
        id: apiPool.id,
        programId: apiPool.programId,
        mintA: apiPool.mintA,
        mintB: apiPool.mintB,
        config: apiPool.config,
        price: apiPool.price,
      },
      rpcData,
    });

    const tickArraysByPool = await PoolUtils.fetchMultiplePoolTickArrays({
      connection,
      poolKeys: [computePool],
      batchRequest: true,
    });

    // computeAmountOut wants tickArrayCache for THIS pool only
    const tickArrayCache = tickArraysByPool[computePool.id.toBase58()] ?? {};

    return { computePool, tickArrayCache };
  }

  return {
    id: `ray:${poolId}`,
    from: mintA,
    to: mintB,
    feeBps: 0,

    /** Quote strictly via PoolUtils.computeAmountOut. */
    async quoteOut(amountIn: bigint): Promise<bigint> {
      // Ensure pool exists (fast fail if not)
      await fetchPoolAccount();

      const { computePool, tickArrayCache } = await buildComputeInputs();
      const epochInfo: EpochInfo = await connection.getEpochInfo();

      const baseMint = new PublicKey(this.from); // input side
      const amountInBN = new BN(amountIn.toString());
      const slippage = CFG.maxSlippageBps / 10_000; // computeAmountOut expects fraction (e.g. 0.002)
      const priceLimit = new Decimal(0); // let SDK choose min/max depending on side

      const out = PoolUtils.computeAmountOut({
        poolInfo: computePool,
        tickArrayCache,
        baseMint,
        epochInfo,
        amountIn: amountInBN,
        slippage,
        priceLimit,
        catchLiquidityInsufficient: true,
      });

      // Return raw base units (BN -> bigint)
      return BigInt(out.amountOut.amount.toString());
    },

    /** Build swap instructions (unchanged): use Raydium builder for execution. */
    async buildSwapIx(
      amountIn: bigint,
      _minOut: bigint,
      user: PublicKey
    ): Promise<TransactionInstruction[]> {
      // We still need the "poolKeys-like" struct; the builder accepts ComputeClmmPoolInfo.
      const { computePool } = await buildComputeInputs();
      const slippage = new Percent(CFG.maxSlippageBps, 10_000);
      const { aToB } = direction(this.from, this.to);

      // In recent SDK cuts makeSwapInstructionSimple accepts `poolInfo: ComputeClmmPoolInfo`
      const res: any = await (PoolUtils as any).constructor // just to satisfy TS if types drift
      ; // no-op to keep TS quiet in some editors

      const swapRes = await (await import('@raydium-io/raydium-sdk-v2')).Clmm.makeSwapInstructionSimple({
        connection,
        poolInfo: computePool,
        ownerInfo: { useSOLBalance: true, wallet: user },
        inputMint: new PublicKey(this.from),
        inputAmount: amountIn,
        slippage,
        aToB,
        makeTxVersion: 0,
      });

      const ixs: TransactionInstruction[] = [];
      for (const itx of swapRes.innerTransactions ?? []) {
        for (const ix of itx.instructions ?? []) ixs.push(ix);
      }
      return ixs;
    },
  };
}
